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

  // A degraded view is UNKNOWN, not empty: show "unknown" so the card never
  // presents a failed extractor's empty result as an authoritative fact. Older
  // caches have no `degraded`/`truncated`; default to a non-degraded, complete map.
  const degraded = new Set(cache.degraded ?? []);
  const view = (name: string, n: number, label: string): string =>
    degraded.has(name) ? `unknown ${label}` : `${n} ${label}`;
  const structureLine = degraded.has("structure")
    ? "source map unknown (not derived);"
    : `${cache.structure.fileCount} source files (${languages}); top dirs: ${dirs || "."};`;

  const lines = [
    `Knowstone project map (built ${isoDate(cache.builtAt)}):`,
    structureLine,
    `${view("routes", cache.routes.length, "routes")}, ${view("schema", cache.schema.length, "DB tables")}, ${view("scripts", cache.scripts.length, "npm scripts")}.`,
  ];
  if (cache.truncated) {
    lines.push("Map is partial (repo exceeded the file cap); treat it as incomplete.");
  }
  if (degraded.size > 0) {
    lines.push(`Some views are unknown, not empty: ${[...degraded].join(", ")}; explore directly.`);
  }
  // The call to action is conditional on there being findings. When some exist,
  // direct the model to recall them FIRST (the two moments that matter: returning
  // to this code, and acting on a prior conclusion) — this is the nudge the M6
  // benchmark showed was missing. When none exist, recall has nothing to return,
  // so point at note/map instead and don't waste a call. The text is still a pure
  // function of stored state, so the card stays static and cache-safe.
  if (findingCount > 0) {
    lines.push(
      `${findingCount} verified finding(s) on record for this project. Before exploring this code or acting on a prior conclusion about it, run knowstone:recall first: it returns these findings freshness-checked and withholds any whose code has changed. Use knowstone:map to refresh the map, knowstone:note to record a new finding.`,
    );
  } else {
    lines.push(
      `No verified findings recorded yet. Use knowstone:note to record a verified conclusion and knowstone:map to refresh the map.`,
    );
  }
  return lines.join(" ");
}
