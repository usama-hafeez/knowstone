/**
 * Knowstone — the session card.
 *
 * A tiny, cache-friendly summary of a project, injected once at session start
 * (see hooks/session-start). It is derived only from the stored index cache and
 * the count of recorded findings — never from scanning the repo — so it is cheap
 * and changes only when `map` is re-run or a finding is added, not on every
 * session. That stability is what keeps it cache-safe for prompt caching. See
 * ../../../PLAN.md (M4).
 */

import { readIndexCache } from "./cache.js";
import { openStore, type StoreOptions } from "./store.js";

/** Format the YYYY-MM-DD part of an epoch-ms timestamp (UTC, deterministic). */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Render the session card for a project as a short, static string. When no map
 * has been built yet, returns a one-line hint instead. Reads only the index
 * cache and the fact count; never scans the repository.
 */
export function renderCard(options: StoreOptions): string {
  const cache = readIndexCache(options);
  if (cache === null) {
    return "Knowstone: no project map yet. Run the knowstone:map skill to build one, then knowstone:recall to retrieve verified findings.";
  }

  let findingCount = 0;
  try {
    findingCount = openStore(options).list().length;
  } catch {
    findingCount = 0; // a store read must never break the card
  }

  const dirs = cache.structure.topLevelDirs
    .slice(0, 4)
    .map((d) => d.name)
    .join(", ");
  const languages = Object.entries(cache.structure.byLanguage)
    .map(([lang, count]) => `${lang} ${count}`)
    .join(", ");

  return [
    `Knowstone project map (built ${isoDate(cache.builtAt)}):`,
    `${cache.structure.fileCount} source files (${languages}); top dirs: ${dirs || "."};`,
    `${cache.routes.length} routes, ${cache.schema.length} DB tables, ${cache.scripts.length} npm scripts.`,
    `${findingCount} verified finding(s) on record.`,
    `Use knowstone:recall to retrieve findings (each is freshness-checked and withheld if its code changed), and knowstone:map to refresh the map.`,
  ].join(" ");
}
