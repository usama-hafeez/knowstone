/**
 * Knowstone — Tier-A cache-size caps (LRU eviction).
 *
 * The per-project index cache (index-cache.json) is Tier A: cheap, derived, and
 * fully regenerable by re-running `map`. To stop these caches growing without
 * bound across many projects, this module enforces a total size budget by evicting
 * the least-recently-built caches first (LRU, by file mtime).
 *
 * The one inviolable rule (PLAN.md M5): **Tier-B findings are never evicted.** Only
 * index-cache.json files are ever removed. facts.json, its facts.corrupt-* backups,
 * and the meta.json isolation marker are never touched — losing a verified finding
 * is data loss; losing a derived cache is a free rebuild.
 *
 * Best-effort: every fs call is guarded so enforcement never throws and never
 * breaks the operation that triggered it.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./log.js";

/** The only filename this module will ever delete. */
const TIER_A_FILE = "index-cache.json";

/** Default total byte budget for all Tier-A index caches under one data dir. */
export const DEFAULT_MAX_TIER_A_BYTES = 50 * 1024 * 1024;

export interface CapsOptions {
  /** Total byte budget for Tier-A caches (default DEFAULT_MAX_TIER_A_BYTES). */
  maxTierABytes?: number;
}

/** One project's Tier-A cache on disk, with the facts we evict by. */
interface TierACache {
  /** The project key (the projects/<key> directory name). */
  key: string;
  /** Absolute path of the index-cache.json file. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last-built time (file mtime, epoch ms) — the LRU key. */
  mtimeMs: number;
}

/** Collect every Tier-A index cache under baseDir/projects. Best-effort. */
function collectTierACaches(baseDir: string): TierACache[] {
  const projectsDir = join(baseDir, "projects");
  if (!existsSync(projectsDir)) return [];

  let keys: string[];
  try {
    keys = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const caches: TierACache[] = [];
  for (const key of keys) {
    const path = join(projectsDir, key, TIER_A_FILE);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      caches.push({ key, path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      continue; // no cache for this project, or unreadable: skip
    }
  }
  return caches;
}

/** The outcome of a caps sweep. */
export interface EnforceResult {
  /** Project keys whose Tier-A cache was evicted, oldest first. */
  evicted: string[];
  /** Total Tier-A bytes remaining after eviction. */
  remainingBytes: number;
}

/**
 * Enforce the Tier-A size budget under baseDir. If the total size of all
 * index-cache.json files exceeds the budget, evict them least-recently-built first
 * (by mtime) until the total is within budget. Never removes anything but
 * index-cache.json, so Tier-B findings are always preserved. Never throws.
 *
 * "Recently used" is approximated by "recently built": `map` rewrites the cache, so
 * a freshly mapped project is always the newest and is never a first eviction
 * candidate.
 */
export function enforceCaps(
  baseDir: string,
  options: CapsOptions = {},
  at?: number,
): EnforceResult {
  const budget = options.maxTierABytes ?? DEFAULT_MAX_TIER_A_BYTES;
  const caches = collectTierACaches(baseDir);

  let total = caches.reduce((sum, c) => sum + c.size, 0);
  if (total <= budget) return { evicted: [], remainingBytes: total };

  // Oldest first: evict least-recently-built caches until within budget.
  const byAge = [...caches].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const evicted: string[] = [];
  for (const cache of byAge) {
    if (total <= budget) break;
    try {
      rmSync(cache.path, { force: true }); // only ever the Tier-A file
      evicted.push(cache.key);
      total -= cache.size;
    } catch {
      continue; // could not evict this one: move on, never throw
    }
  }

  if (evicted.length > 0) {
    logEvent(
      baseDir,
      "cache-evict",
      { evicted: evicted.length, keys: evicted, remainingBytes: total, budget },
      at,
    );
  }
  return { evicted, remainingBytes: total };
}
