/**
 * Knowstone — incremental, Merkle-diff-driven re-indexing.
 *
 * Re-indexing a whole repository on every edit is wasteful. Given a previous
 * file-hash snapshot and the current repo, this module finds exactly which files
 * changed (added, removed, modified), maps those changes to the modules whose
 * knowledge may now be stale, and re-runs only the relevant extractors instead of
 * re-extracting everything. It is read-only and deterministic: it never writes to
 * disk, never touches git, and the same inputs always produce the same plan.
 *
 * Two complementary ideas live here, and they are deliberately kept apart:
 *
 *  1. Cone impact (`impactedFiles`). A Knowstone fact bound to file F depends on
 *     F's dependency cone — F plus everything F transitively imports (see
 *     ./imports.ts). So a change to any file X makes F's bound fact potentially
 *     stale when X is in F's cone, i.e. when F can reach X forward in the import
 *     graph. The set of such F is the reverse-reachable set from the changed
 *     files. This is what a caller re-verifies or re-binds, and it mirrors the
 *     freshness engine's withhold rule (./freshness.ts). We would rather
 *     over-invalidate than miss a dependency, so removals are mapped through an
 *     augmented graph (below) and anything we cannot place is recomputed.
 *
 *  2. Extractor-value re-run (`rerun`). The structure/route/schema extractors
 *     derive their output purely from each file's own text (a route is read from
 *     the file that declares it, not from what that file imports). So their output
 *     changes only when a relevant file's own content changes, and re-running them
 *     is driven by the changed files themselves, not by whole cones. We still
 *     skip an extractor entirely when nothing it reads has changed.
 *
 * See ../../../PLAN.md (M3).
 */

import { hashFile, type FileHash } from "./hash.js";
import { buildImportGraph, detectLanguage, type ImportGraph, type Language } from "./imports.js";
import { buildIndex, type Index, type ListOptions } from "./indexer.js";
import { extractRoutes, type Route } from "./routes.js";
import { extractSchema, findSqlFiles, type Table } from "./schema.js";
import { extractStructure, type StructureSummary } from "./structure.js";

/**
 * A point-in-time map of repo-relative path to content hash, plus the engine
 * version that produced it. Keys are repo-relative with forward slashes and are
 * stored in sorted order so the object serialises deterministically.
 */
export interface HashSnapshot {
  /** The engine version at snapshot time. A change forces a full rebuild. */
  toolVersion: string;
  /** Repo-relative (forward slash) path -> lowercase hex sha256, sorted by key. */
  files: Record<string, string>;
}

/** The set difference between two snapshots. Every list is sorted. */
export interface SnapshotDiff {
  /** Paths present now but not before. */
  added: string[];
  /** Paths present before but not now. */
  removed: string[];
  /** Paths present in both whose hash differs. */
  modified: string[];
  /** Paths present in both with the same hash. */
  unchanged: string[];
}

/** Languages whose files carry HTTP routes the route extractor can read. */
const ROUTE_LANGUAGES: ReadonlySet<Language> = new Set<Language>(["php", "ts", "js"]);

/** True for a plain SQL file (tracked for the schema extractor; not in the graph). */
function isSqlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".sql");
}

/** True for a file that the route extractor scans (Laravel PHP or Express/Fastify ts/js). */
function isRouteFile(path: string): boolean {
  const language = detectLanguage(path);
  return language !== null && ROUTE_LANGUAGES.has(language);
}

/** True for a file the schema extractor reads: a Laravel PHP migration or a .sql file. */
function isSchemaFile(path: string): boolean {
  return detectLanguage(path) === "php" || isSqlFile(path);
}

/** True for a file that is a node in the import graph (any language the indexer tracks). */
function isGraphFile(path: string): boolean {
  return detectLanguage(path) !== null && !isSqlFile(path);
}

/**
 * Hash the given repo-relative files into a snapshot. Read-only. Best-effort: a
 * file that cannot be read (for example it vanished mid-run) is simply left out,
 * so the next diff treats it as removed rather than throwing. Keys are inserted
 * in sorted order for a stable serialisation.
 */
export function buildSnapshot(root: string, files: string[], toolVersion: string): HashSnapshot {
  const hashes = new Map<string, string>();
  for (const file of files) {
    let fileHash: FileHash;
    try {
      fileHash = hashFile(root, file);
    } catch {
      continue; // unreadable file: omit, best-effort
    }
    hashes.set(fileHash.path, fileHash.hash);
  }

  const out: Record<string, string> = {};
  for (const path of [...hashes.keys()].sort()) {
    out[path] = hashes.get(path) as string;
  }
  return { toolVersion, files: out };
}

/**
 * Snapshot an index together with the repo's .sql files (which are not part of
 * the import graph but are read by the schema extractor). Read-only.
 */
export function snapshotRepo(index: Index, toolVersion: string): HashSnapshot {
  const files = [...index.files, ...findSqlFiles(index.root)];
  return buildSnapshot(index.root, files, toolVersion);
}

/**
 * Compare two snapshots by content hash. The tool version is not consulted here
 * (callers decide what a version change means); only the file maps are diffed.
 * Every returned list is sorted.
 */
export function diffSnapshots(previous: HashSnapshot, current: HashSnapshot): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  const keys = new Set<string>([...Object.keys(previous.files), ...Object.keys(current.files)]);
  for (const key of [...keys].sort()) {
    const before = previous.files[key];
    const after = current.files[key];
    if (before === undefined) {
      added.push(key);
    } else if (after === undefined) {
      removed.push(key);
    } else if (before !== after) {
      modified.push(key);
    } else {
      unchanged.push(key);
    }
  }

  return { added, removed, modified, unchanged };
}

/**
 * Every file that can reach one of `changed` by following import edges forward —
 * i.e. every file whose dependency cone contains a changed file. Computed as the
 * reverse-reachable set from `changed` over the graph, and it includes the
 * changed files themselves. Terminates on cycles.
 */
export function dependentsOf(graph: ImportGraph, changed: Iterable<string>): Set<string> {
  // Reverse adjacency: target -> the files that import it.
  const reverse = new Map<string, Set<string>>();
  for (const [from, targets] of graph.edges) {
    for (const target of targets) {
      let importers = reverse.get(target);
      if (importers === undefined) {
        importers = new Set<string>();
        reverse.set(target, importers);
      }
      importers.add(from);
    }
  }

  const result = new Set<string>();
  const stack = [...changed];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || result.has(current)) continue;
    result.add(current);
    const importers = reverse.get(current);
    if (importers !== undefined) {
      for (const importer of importers) {
        if (!result.has(importer)) stack.push(importer);
      }
    }
  }

  return result;
}

/** Which extractors a plan says must re-run. */
export interface RerunFlags {
  /** The structure summary (counts, top dirs, entry points). */
  structure: boolean;
  /** The HTTP route list. */
  routes: boolean;
  /** The DB-schema table list. */
  schema: boolean;
}

/** A deterministic, read-only plan for what an incremental re-index must redo. */
export interface IncrementalPlan {
  /** The file-level diff that drives everything below. */
  diff: SnapshotDiff;
  /**
   * True when nothing can be reused and the repo must be fully re-extracted:
   * the previous snapshot was empty, or the engine version changed (old hashes
   * are no longer comparable).
   */
  fullRebuild: boolean;
  /**
   * Current graph files whose dependency cone touches a changed file — the
   * modules whose bound facts may now be stale and need re-deriving or
   * re-verifying. Sorted; excludes removed files and .sql files. On a full
   * rebuild this is every current graph file.
   */
  impactedFiles: string[];
  /** Which extractors must re-run given the changed files. */
  rerun: RerunFlags;
}

/**
 * Plan an incremental re-index from a previous snapshot to the current snapshot,
 * using the current index for the import graph. Pure and deterministic.
 *
 * `impactedFiles` (the cone map) is computed by reverse reachability. Modified
 * and added files are mapped through the current graph. Removed files no longer
 * exist as graph nodes, so when any file was removed we map through an augmented
 * graph built over the current files plus the removed paths: an unchanged file
 * that still imports a removed path then resolves to it, so the removed file's
 * dependents are still found. The augmented graph is built only when needed.
 */
export function planIncremental(
  currentIndex: Index,
  previous: HashSnapshot,
  current: HashSnapshot,
): IncrementalPlan {
  const diff = diffSnapshots(previous, current);
  const currentFiles = new Set(Object.keys(current.files));

  const fullRebuild =
    Object.keys(previous.files).length === 0 || previous.toolVersion !== current.toolVersion;

  if (fullRebuild) {
    const impactedFiles = [...currentFiles].filter(isGraphFile).sort();
    return {
      diff,
      fullRebuild: true,
      impactedFiles,
      rerun: { structure: true, routes: true, schema: true },
    };
  }

  const addedGraph = diff.added.filter(isGraphFile);
  const modifiedGraph = diff.modified.filter(isGraphFile);
  const removedGraph = diff.removed.filter(isGraphFile);

  // Choose the graph used for reverse reachability. With no graph-file removals
  // the current graph is exact; otherwise augment it so removed paths are still
  // resolvable as import targets and their dependents can be reached.
  let mapGraph = currentIndex.graph;
  if (removedGraph.length > 0) {
    mapGraph = buildImportGraph(currentIndex.root, [...currentIndex.files, ...removedGraph]);
  }

  // Sources for reverse reachability: every changed graph file. Added files are
  // seeded too, not only for their own new facts but because an added file can
  // SHADOW a prior resolution target (a new `thing.ts` overriding an already
  // imported `thing.js`, since `.ts` resolves before `.js`), silently changing
  // the cone of a present, unchanged importer. Seeding the added file flags that
  // importer. An added file nothing imports simply seeds only itself.
  const sources = [...addedGraph, ...modifiedGraph, ...removedGraph];
  const reachable = dependentsOf(mapGraph, sources);

  const impacted = new Set<string>();
  for (const file of reachable) {
    if (currentFiles.has(file) && isGraphFile(file)) impacted.add(file);
  }

  const schemaChanged = [...diff.added, ...diff.modified, ...diff.removed].some(isSchemaFile);
  const routeChanged = [...addedGraph, ...modifiedGraph, ...removedGraph].some(isRouteFile);
  // Structure (file count, language mix, top dirs, entry points) is derived from
  // the index's graph files alone, so any graph-file change may alter it.
  const structureChanged =
    addedGraph.length > 0 || removedGraph.length > 0 || modifiedGraph.length > 0;

  return {
    diff,
    fullRebuild: false,
    impactedFiles: [...impacted].sort(),
    rerun: { structure: structureChanged, routes: routeChanged, schema: schemaChanged },
  };
}

/** The three Tier-A derived views an index produces. */
export interface ExtractResult {
  structure: StructureSummary;
  routes: Route[];
  schema: Table[];
}

/** Options for an incremental update. */
export interface IncrementalUpdateOptions extends ListOptions {
  /**
   * The engine version running now. Defaults to the previous snapshot's version;
   * pass the real current version so a version bump triggers a full rebuild.
   */
  toolVersion?: string;
}

/** The outcome of an incremental update: the fresh views, the new snapshot, and why. */
export interface IncrementalUpdateResult {
  /** The updated extractor outputs (reused where nothing relevant changed). */
  result: ExtractResult;
  /** The snapshot of the repo as it is now, to persist for the next run. */
  snapshot: HashSnapshot;
  /** The plan that was applied (diff, impacted modules, which extractors re-ran). */
  plan: IncrementalPlan;
}

/** Total order matching extractRoutes, so a merged route list stays deterministic. */
function compareRoutes(a: Route, b: Route): number {
  return (
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.line - b.line ||
    (a.method < b.method ? -1 : a.method > b.method ? 1 : 0)
  );
}

/**
 * Re-extract routes incrementally: re-scan only the route-bearing files that
 * changed, keep every other file's previous routes, and drop routes for files no
 * longer present. The merged list is sorted exactly as extractRoutes sorts.
 */
function updateRoutes(index: Index, previous: Route[], diff: SnapshotDiff): Route[] {
  const present = new Set(index.files);
  // Files to re-scan: added or modified route files that still exist.
  const rescan = [...diff.added, ...diff.modified].filter(
    (file) => isRouteFile(file) && present.has(file),
  );
  const rescanSet = new Set(rescan);

  // Keep previous routes whose file still exists and was not re-scanned.
  const retained = previous.filter((r) => present.has(r.file) && !rescanSet.has(r.file));

  // Re-extract the changed route files via a sub-index (extractRoutes reads file
  // content and ignores the graph, so a bare file list is enough).
  const subIndex: Index = { root: index.root, files: [...rescan].sort(), graph: index.graph };
  const fresh = rescanSet.size === 0 ? [] : extractRoutes(subIndex);

  return [...retained, ...fresh].sort(compareRoutes);
}

/**
 * Incrementally update the three Tier-A views for `root` from a previous snapshot
 * and the previous views. Builds the current index (read-only), diffs the
 * snapshots, and re-runs only the extractors the plan flags — reusing the
 * previous output otherwise. Returns the updated views, the new snapshot to
 * persist, and the plan. Never writes anything.
 */
export function incrementalUpdate(
  root: string,
  previous: HashSnapshot,
  previousResult: ExtractResult,
  options: IncrementalUpdateOptions = {},
): IncrementalUpdateResult {
  const { toolVersion, ...listOptions } = options;
  const index = buildIndex(root, listOptions);
  const version = toolVersion ?? previous.toolVersion;
  const snapshot = snapshotRepo(index, version);
  const plan = planIncremental(index, previous, snapshot);

  if (plan.fullRebuild) {
    return {
      result: {
        structure: extractStructure(index),
        routes: extractRoutes(index),
        schema: extractSchema(index),
      },
      snapshot,
      plan,
    };
  }

  const structure = plan.rerun.structure ? extractStructure(index) : previousResult.structure;
  const routes = plan.rerun.routes
    ? updateRoutes(index, previousResult.routes, plan.diff)
    : previousResult.routes;
  const schema = plan.rerun.schema ? extractSchema(index) : previousResult.schema;

  return { result: { structure, routes, schema }, snapshot, plan };
}
