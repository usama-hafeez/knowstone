/**
 * Knowstone — the local fact store.
 *
 * Facts (a remembered structural detail or a verified finding) are kept on disk,
 * isolated per project, and never deleted: a fact that no longer holds is marked
 * superseded, keeping the history. Every write runs through the secret guard
 * first, so a fact whose text looks like it contains a credential is refused and
 * never reaches disk. See ../../../PLAN.md (M2).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashContent } from "./hash.js";
import type { Binding } from "./freshness.js";
import { scanForSecrets } from "./secret-guard.js";
import { logEvent } from "./log.js";

export type FactKind = "structure" | "finding";

export interface Fact {
  id: string;
  kind: FactKind;
  /** The remembered text. */
  statement: string;
  /** The evidence binding this fact depends on (from the freshness engine). */
  binding: Binding;
  createdAt: number;
  /** id of the fact that replaced this one, or null while this fact still stands. */
  supersededBy: string | null;
}

export interface FactInput {
  kind: FactKind;
  statement: string;
  binding: Binding;
  /** Defaults to Date.now(). */
  createdAt?: number;
}

/** Thrown when a fact is refused because its text looks like it contains secrets. */
export class SecretError extends Error {
  readonly kinds: string[];
  constructor(kinds: string[]) {
    const unique = [...new Set(kinds)].join(", ");
    super(`refused to store fact: text contains possible secrets [${unique}]`);
    this.name = "SecretError";
    this.kinds = kinds;
  }
}

export interface StoreOptions {
  /** Base directory for all Knowstone data (for example CLAUDE_PLUGIN_DATA). */
  baseDir: string;
  /** Absolute path of the project this store belongs to; used to isolate projects. */
  projectRoot: string;
}

export interface ListOptions {
  /** Include facts that have been superseded. Default false. */
  includeSuperseded?: boolean;
}

export interface KnowstoneStore {
  /** Store a new fact. Throws SecretError if the statement looks like it contains secrets. */
  put(input: FactInput): Fact;
  get(id: string): Fact | undefined;
  list(options?: ListOptions): Fact[];
  /** Replace a fact: mark the old one superseded (never deleted) and add the new one. */
  supersede(oldId: string, input: FactInput): Fact;
  /** The on-disk path backing this store. */
  readonly path: string;
}

interface StoreFile {
  version: number;
  facts: Fact[];
}

const STORE_VERSION = 1;

/** The outcome of loading the on-disk facts file. */
interface LoadResult {
  facts: Fact[];
  /**
   * True when the file existed but could not be fully read as a valid store (bad
   * JSON, a non-array `facts`, or one or more malformed entries). A corrupt file
   * must be preserved, not overwritten, so the first write quarantines it first.
   */
  corrupt: boolean;
}

/**
 * Minimal shape check for a persisted fact. Findings are Tier-B (precious), so a
 * partially-corrupt file keeps every entry that still looks like a usable fact
 * and only the unrecoverable ones are dropped (and the file is quarantined so the
 * dropped bytes are never lost). Checks only the fields the engine relies on.
 */
function isValidFact(value: unknown): value is Fact {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Partial<Fact>;
  return (
    typeof f.id === "string" &&
    (f.kind === "structure" || f.kind === "finding") &&
    typeof f.statement === "string" &&
    typeof f.binding === "object" &&
    f.binding !== null &&
    typeof f.createdAt === "number" &&
    (f.supersededBy === null || typeof f.supersededBy === "string")
  );
}

/**
 * Canonical absolute form of a project root, resolving 8.3 short names,
 * drive-letter case and symlinks so independent entry points (a skill run from
 * the project cwd, the SessionStart hook reading CLAUDE_PROJECT_DIR) key the same
 * project to the same store. Best-effort: falls back to the given path if it
 * cannot be resolved (for example it does not exist).
 */
export function canonicalProjectRoot(projectRoot: string): string {
  try {
    return realpathSync.native(projectRoot);
  } catch {
    return projectRoot;
  }
}

/**
 * A short, stable key for a project, derived from its absolute path. Uses 128 bits
 * (32 hex chars) of the path hash so two distinct projects cannot realistically
 * collide into the same data directory (the isolation marker is a second line of
 * defence against the astronomically unlikely collision).
 */
export function projectKey(projectRoot: string): string {
  const normalised = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return hashContent(normalised).slice(0, 32);
}

/**
 * The per-project data directory for a store: baseDir/projects/<key>. Exposed so
 * sibling caches (for example the Tier-A index cache) can live alongside the
 * facts file under the same project-isolated key.
 */
export function projectDir(options: StoreOptions): string {
  return join(options.baseDir, "projects", projectKey(options.projectRoot));
}

/** The isolation marker path for a project's data directory. */
function markerPath(options: StoreOptions): string {
  return join(projectDir(options), "meta.json");
}

/** The project root recorded in the data dir's isolation marker, or null if none. */
function readMarkerRoot(options: StoreOptions): string | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(options), "utf8")) as {
      projectRoot?: unknown;
    };
    return typeof parsed.projectRoot === "string" ? parsed.projectRoot : null;
  } catch {
    return null; // no marker, or unreadable: nothing recorded
  }
}

/**
 * Write the isolation marker if absent, recording which project owns this data
 * directory. Best-effort and write-once: an existing marker is never overwritten,
 * so a (detected) collision is preserved for assertProjectDir to catch.
 */
export function writeProjectMarker(options: StoreOptions): void {
  try {
    if (readMarkerRoot(options) !== null) return;
    const dir = projectDir(options);
    mkdirSync(dir, { recursive: true });
    const tmp = `${markerPath(options)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ projectRoot: options.projectRoot }), "utf8");
    renameSync(tmp, markerPath(options));
  } catch {
    // The marker is a defensive aid, not load-bearing: never fail a write over it.
  }
}

/**
 * Thrown when a data directory already belongs to a different project (a key
 * collision). We refuse rather than ever serve or clobber another project's data.
 */
export class ProjectCollisionError extends Error {
  constructor(projectRoot: string, owner: string) {
    super(
      `knowstone: data directory for "${projectRoot}" is already claimed by "${owner}"; refusing to avoid cross-project data bleed`,
    );
    this.name = "ProjectCollisionError";
  }
}

/**
 * Guard against cross-project bleed: if this data directory carries a marker for a
 * different project root, fail loudly instead of reading or writing another
 * project's facts. Logs the anomaly. A no-op in the normal case (no marker, or a
 * matching one). With 128-bit keys this never triggers in practice; it exists so a
 * collision can never silently bleed.
 */
export function assertProjectDir(options: StoreOptions): void {
  const owner = readMarkerRoot(options);
  if (owner !== null && owner !== options.projectRoot) {
    logEvent(options.baseDir, "isolation-collision", {
      projectKey: projectKey(options.projectRoot),
      owner,
    });
    throw new ProjectCollisionError(options.projectRoot, owner);
  }
}

export function openStore(options: StoreOptions): KnowstoneStore {
  assertProjectDir(options); // never serve or clobber another project's facts
  const dir = projectDir(options);
  const filePath = join(dir, "facts.json");

  const load = (): LoadResult => {
    if (!existsSync(filePath)) return { facts: [], corrupt: false };
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      // Present but unreadable: treat as corrupt so we never silently discard it.
      return { facts: [], corrupt: true };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      if (!parsed || !Array.isArray(parsed.facts)) return { facts: [], corrupt: true };
      const valid = parsed.facts.filter(isValidFact);
      // A file whose entries were partly unreadable is still corrupt: keep the
      // recoverable facts in memory but preserve the original bytes on next write.
      return { facts: valid, corrupt: valid.length !== parsed.facts.length };
    } catch {
      // A corrupt store must never crash the plugin: start empty in memory and
      // preserve the bad file (quarantine) on the next write, never overwrite it.
      return { facts: [], corrupt: true };
    }
  };

  const loaded = load();
  const byId = new Map<string, Fact>(loaded.facts.map((f): [string, Fact] => [f.id, f]));
  // Set once the corrupt file has been moved aside, so we quarantine only once.
  let corruptQuarantined = !loaded.corrupt;

  /**
   * Preserve a corrupt facts file before the first write overwrites it. Tier-B
   * findings are precious, so the original bytes are renamed to a timestamped
   * sidecar for human recovery rather than being lost. Best-effort: a failure to
   * move it must not block the (self-healing) write.
   */
  const quarantineCorrupt = (): void => {
    if (corruptQuarantined) return;
    corruptQuarantined = true;
    try {
      if (existsSync(filePath)) {
        const sidecar = join(dir, `facts.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
        renameSync(filePath, sidecar);
        logEvent(options.baseDir, "store-quarantine", {
          projectKey: projectKey(options.projectRoot),
          sidecar: sidecar.slice(dir.length + 1), // filename only, not the full path
        });
      }
    } catch {
      // If we cannot move it aside, we still proceed: self-healing the store
      // matters more than the backup, and the write below is atomic.
    }
  };

  const persist = (): void => {
    mkdirSync(dir, { recursive: true });
    quarantineCorrupt(); // preserve any corrupt original before we replace it
    writeProjectMarker(options); // claim this data dir for this project
    const out: StoreFile = { version: STORE_VERSION, facts: [...byId.values()] };
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
    renameSync(tmp, filePath);
  };

  const guard = (statement: string): void => {
    const scan = scanForSecrets(statement);
    if (!scan.safe) throw new SecretError(scan.findings.map((f) => f.kind));
  };

  const create = (input: FactInput): Fact => ({
    id: randomUUID(),
    kind: input.kind,
    statement: input.statement,
    binding: input.binding,
    createdAt: input.createdAt ?? Date.now(),
    supersededBy: null,
  });

  return {
    path: filePath,

    put(input: FactInput): Fact {
      guard(input.statement); // refuse secrets before anything touches disk
      const fact = create(input);
      byId.set(fact.id, fact);
      persist();
      return fact;
    },

    get(id: string): Fact | undefined {
      return byId.get(id);
    },

    list(listOptions?: ListOptions): Fact[] {
      const includeSuperseded = listOptions?.includeSuperseded ?? false;
      const all = [...byId.values()];
      const chosen = includeSuperseded ? all : all.filter((f) => f.supersededBy === null);
      return chosen.sort((a, b) => a.createdAt - b.createdAt);
    },

    supersede(oldId: string, input: FactInput): Fact {
      guard(input.statement); // refuse secrets before any mutation
      const existing = byId.get(oldId);
      if (existing === undefined) {
        throw new Error(`cannot supersede unknown fact id "${oldId}"`);
      }
      const replacement = create(input);
      byId.set(oldId, { ...existing, supersededBy: replacement.id });
      byId.set(replacement.id, replacement);
      persist();
      return replacement;
    },
  };
}
