/**
 * Knowstone — the freshness check: given a fact's binding (the evidence it was
 * derived from, captured at bind time) and the current state of the repo, decide
 * whether the fact is still FRESH, has gone STALE, or is UNKNOWN and must be
 * re-verified by a human.
 *
 * The guiding rule is: never serve a fact as FRESH when we cannot prove it. Every
 * cheap short-circuit in here may only move us towards withholding, never towards
 * a false FRESH. The content hash of the cone is the single source of truth; the
 * tool-version, TTL, incomplete-cone and git checks can only withhold or confirm,
 * they can never override a real content change. See ../../../PLAN.md (M1).
 */

import { hashFile, merkleRoot, type FileHash } from "./hash.js";
import { dependencyCone, type ImportGraph } from "./imports.js";

export type Status = "FRESH" | "STALE" | "UNKNOWN";

export interface Binding {
  /** The engine version that produced this binding. */
  toolVersion: string;
  /** When the binding was created, epoch milliseconds. */
  createdAt: number;
  /** Optional time-to-live in milliseconds. Omit for no expiry. */
  ttlMs?: number;
  /** Optional git commit the binding was captured at, used as a fast-path anchor. */
  gitCommit?: string;
  /** The files in the dependency cone and their hashes at bind time. */
  cone: FileHash[];
  /** Merkle root of the cone at bind time (belt-and-braces over the whole set). */
  coneRoot: string;
  /**
   * False when the import graph for this cone could not be fully resolved (for
   * example the code uses path aliases or dynamic imports we cannot follow). A
   * known-incomplete cone cannot be promised FRESH in strict mode.
   */
  coneComplete: boolean;
}

export interface RepoSnapshot {
  /** Absolute repo root the relative cone paths resolve against. */
  root: string;
  /** The engine version running now. */
  toolVersion: string;
  /** Current time, epoch milliseconds. */
  now: number;
  /** Current git HEAD, if known. */
  gitCommit?: string;
  /**
   * Reserved for the M2 git fast-path: it will mean a trusted check has confirmed
   * the cone files have no uncommitted changes. Not yet honoured; M1 always
   * re-hashes, so setting it has no effect.
   */
  gitCleanForCone?: boolean;
}

export interface FreshnessOptions {
  /**
   * When true (the default), a known-incomplete cone is withheld as UNKNOWN
   * rather than risk a false FRESH. Set false only for callers that knowingly
   * accept best-effort invalidation.
   */
  strict?: boolean;
}

export interface FreshnessResult {
  status: Status;
  /** A short human-readable reason, for the re-verify prompt. */
  reason: string;
  /** Cone paths that changed (populated for STALE). */
  changed: string[];
}

/**
 * Decide the freshness of a fact from its binding and the current repo snapshot.
 * The checks run in a fixed order and each may only withhold or confirm.
 */
export function checkFreshness(
  binding: Binding,
  snapshot: RepoSnapshot,
  options: FreshnessOptions = {},
): FreshnessResult {
  const strict = options.strict ?? true;

  // 0. No evidence. A fact bound to nothing can never be proven stale, so it must
  //    never be served as a verified fact: always withhold.
  if (binding.cone.length === 0) {
    return { status: "UNKNOWN", reason: "no evidence recorded; re-verify", changed: [] };
  }

  // 1. Tool version. If the engine changed, the stored hashes may not be
  //    comparable to what we would compute now, so we cannot judge: withhold.
  if (binding.toolVersion !== snapshot.toolVersion) {
    return {
      status: "UNKNOWN",
      reason: `engine version changed (${binding.toolVersion} to ${snapshot.toolVersion}); re-verify`,
      changed: [],
    };
  }

  // 2. TTL. An expired binding is stale by policy, regardless of content.
  if (binding.ttlMs !== undefined && snapshot.now - binding.createdAt > binding.ttlMs) {
    return { status: "STALE", reason: "binding expired (TTL)", changed: [] };
  }

  // 3. Incomplete cone. We cannot promise freshness for a cone we could not fully
  //    resolve, because a dependency we never recorded could have changed. This is
  //    checked before any fast-path so a known gap always withholds in strict mode.
  if (strict && !binding.coneComplete) {
    return {
      status: "UNKNOWN",
      reason: "dependency graph incomplete (unresolved imports); re-verify",
      changed: [],
    };
  }

  // 4. Git fast-path is deferred to M2. Until a trusted check can confirm the
  //    cone is clean at the current commit, we never short-circuit on git
  //    metadata: every check below is authoritative. The gitCommit is still
  //    recorded on the binding so M2 can add that fast-path safely.

  // 5. Authoritative check: re-hash every cone file from disk. Size is a cheap
  //    first signal but the hash is what decides. A missing/unreadable evidence
  //    file is a definite change.
  const changed: string[] = [];
  const current: FileHash[] = [];
  for (const file of binding.cone) {
    let fresh: FileHash;
    try {
      fresh = hashFile(snapshot.root, file.path);
    } catch {
      changed.push(file.path);
      continue;
    }
    current.push(fresh);
    if (fresh.hash !== file.hash) {
      changed.push(file.path);
    }
  }

  if (changed.length > 0) {
    return { status: "STALE", reason: `evidence changed: ${changed.join(", ")}`, changed };
  }

  // 6. Cone root over the whole set, as a final guard against a combine bug or a
  //    set that no longer matches. Only reachable when every file matched above.
  if (merkleRoot(current) !== binding.coneRoot) {
    return {
      status: "STALE",
      reason: "cone root mismatch",
      changed: binding.cone.map((f) => f.path),
    };
  }

  return { status: "FRESH", reason: "all evidence unchanged", changed: [] };
}

/**
 * Build a binding for a fact derived from one or more evidence files. The cone is
 * the union of the forward import closure of every evidence file; each cone file
 * is hashed from disk now. Pass coneComplete: false when the import graph for
 * these files could not be fully resolved.
 */
export function buildBinding(
  snapshot: Pick<RepoSnapshot, "root" | "toolVersion" | "now" | "gitCommit">,
  evidenceFiles: string[],
  graph: ImportGraph,
  options: { ttlMs?: number; coneComplete?: boolean } = {},
): Binding {
  const coneSet = new Set<string>();
  for (const file of evidenceFiles) {
    for (const member of dependencyCone(graph, file)) {
      coneSet.add(member);
    }
  }

  const conePaths = [...coneSet].sort();
  const cone = conePaths.map((path) => hashFile(snapshot.root, path));

  // Derive completeness from the graph rather than assuming it: the cone is only
  // complete if none of its files had an import we could not account for. A
  // caller may still override this explicitly.
  const derivedComplete = !conePaths.some((path) => graph.incomplete.has(path));

  return {
    toolVersion: snapshot.toolVersion,
    createdAt: snapshot.now,
    ttlMs: options.ttlMs,
    gitCommit: snapshot.gitCommit,
    cone,
    coneRoot: merkleRoot(cone),
    coneComplete: options.coneComplete ?? derivedComplete,
  };
}
