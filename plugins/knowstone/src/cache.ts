/**
 * Knowstone — the Tier-A index cache.
 *
 * `map` derives the cheap, regenerable project facts (structure, routes, DB
 * schema, npm scripts) plus the file-hash snapshot, and stores them here so the
 * session card can show a stable summary and a later `map` can refresh
 * incrementally. This cache sits beside the fact store, under the same
 * per-project-isolated directory (see store.ts `projectDir`). It is Tier A: if it
 * is missing or a different cache version, it is simply rebuilt — never trusted
 * blindly. See ../../../PLAN.md (M4).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir, type StoreOptions } from "./store.js";
import type { HashSnapshot } from "./incremental.js";
import type { StructureSummary } from "./structure.js";
import type { Route } from "./routes.js";
import type { Table } from "./schema.js";
import type { ScriptEntry } from "./scripts.js";

/** The derived Tier-A views of a project, plus the snapshot they were built from. */
export interface IndexCache {
  /** Cache-format version; a mismatch forces a rebuild. */
  version: number;
  /** The engine version that built this cache. */
  toolVersion: string;
  /** When the cache was built, epoch milliseconds. */
  builtAt: number;
  /** File-hash snapshot of the repo at build time (for incremental refresh). */
  snapshot: HashSnapshot;
  structure: StructureSummary;
  routes: Route[];
  schema: Table[];
  scripts: ScriptEntry[];
}

const CACHE_VERSION = 1;

/** The on-disk path of the index cache for a project. */
export function cachePath(options: StoreOptions): string {
  return join(projectDir(options), "index-cache.json");
}

/**
 * Load the index cache, or null when there is none, it cannot be parsed, or its
 * cache-format version does not match (a stale format is rebuilt, not trusted).
 */
export function readIndexCache(options: StoreOptions): IndexCache | null {
  const filePath = cachePath(options);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<IndexCache>;
    if (!isValidCache(parsed)) return null;
    return parsed;
  } catch {
    // A corrupt cache must never crash the plugin: treat as absent.
    return null;
  }
}

/**
 * Validate a parsed cache's shape so a partial-but-version-matching file is
 * rebuilt rather than read into a card render that then throws. Checks every
 * field the card and incremental refresh rely on.
 */
function isValidCache(parsed: Partial<IndexCache> | null | undefined): parsed is IndexCache {
  if (!parsed || parsed.version !== CACHE_VERSION) return false;
  if (typeof parsed.builtAt !== "number" || !Number.isFinite(parsed.builtAt)) return false;
  if (typeof parsed.snapshot !== "object" || parsed.snapshot === null) return false;
  if (!Array.isArray(parsed.routes) || !Array.isArray(parsed.schema)) return false;
  if (!Array.isArray(parsed.scripts)) return false;
  const structure = parsed.structure;
  if (typeof structure !== "object" || structure === null) return false;
  if (typeof structure.fileCount !== "number") return false;
  if (!Array.isArray(structure.topLevelDirs)) return false;
  if (typeof structure.byLanguage !== "object" || structure.byLanguage === null) return false;
  return true;
}

/**
 * Write the index cache atomically (temp file then rename), creating the
 * per-project directory if needed. The caller supplies everything but the
 * cache-format version, which is stamped here.
 */
export function writeIndexCache(options: StoreOptions, cache: Omit<IndexCache, "version">): void {
  const dir = projectDir(options);
  mkdirSync(dir, { recursive: true });
  const out: IndexCache = { version: CACHE_VERSION, ...cache };
  const filePath = cachePath(options);
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  renameSync(tmp, filePath);
}
