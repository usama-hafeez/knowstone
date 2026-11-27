/**
 * Knowstone — the session card.
 *
 * A compact, cache-friendly briefing for a project, injected once at session
 * start (see hooks/session-start). It is derived from the stored index cache and
 * the recorded findings, freshness-checked against the current code — never from
 * a full repo scan. It carries the still-current findings DIRECTLY so the model
 * has them from turn one without having to choose to run recall (the live proof
 * showed that choice is unreliable); findings whose code has changed are withheld
 * and only counted, preserving the trust guarantee passively. It changes only
 * when `map` is re-run, a finding is added, or a finding's code changes — not on
 * every turn — and is injected once per session, so it stays prompt-cache-safe.
 * See ../../../PLAN.md (M4).
 */

import { readIndexCache } from "./cache.js";
import { checkFreshness } from "./freshness.js";
import { KNOWSTONE_VERSION } from "./index.js";
import { openStore, type StoreOptions } from "./store.js";

/** Cap on findings freshness-checked at session start (bounds the hook's work). */
const MAX_EVALUATED = 40;
/** Cap on still-current findings shown inline (the rest are a "+N more" pointer). */
const MAX_SHOWN = 4;
/** Each shown statement is truncated to this many characters to keep the card small. */
const STATEMENT_CAP = 200;

/** Format the YYYY-MM-DD part of an epoch-ms timestamp (UTC, deterministic). */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Collapse whitespace and truncate a statement for inline display in the card. */
function clip(statement: string): string {
  const flat = statement.replace(/\s+/g, " ").trim();
  return flat.length <= STATEMENT_CAP ? flat : `${flat.slice(0, STATEMENT_CAP - 1)}…`;
}

/** The freshness-gated findings view the card needs: current ones and a held count. */
interface FindingsView {
  total: number;
  freshShown: string[];
  freshTotal: number;
  heldCount: number;
  evaluatedAll: boolean;
}

/**
 * Freshness-check the recorded findings and split them into the still-current
 * ones (to show) and a count of those held for re-verify. Bounded by
 * MAX_EVALUATED and fully defended: any failure yields an empty view so the card
 * degrades to the map-only summary rather than breaking session start.
 */
function viewFindings(options: StoreOptions, now: number): FindingsView {
  const empty: FindingsView = {
    total: 0,
    freshShown: [],
    freshTotal: 0,
    heldCount: 0,
    evaluatedAll: true,
  };
  try {
    const facts = openStore(options).list();
    const freshShown: string[] = [];
    let freshTotal = 0;
    let heldCount = 0;
    let evaluated = 0;
    for (const fact of facts) {
      if (evaluated >= MAX_EVALUATED) break;
      evaluated += 1;
      let fresh = false;
      try {
        fresh =
          checkFreshness(fact.binding, {
            root: options.projectRoot,
            toolVersion: KNOWSTONE_VERSION,
            now,
          }).status === "FRESH";
      } catch {
        fresh = false; // a check failure withholds, never serves
      }
      if (fresh) {
        freshTotal += 1;
        if (freshShown.length < MAX_SHOWN) freshShown.push(clip(fact.statement));
      } else {
        heldCount += 1;
      }
    }
    return {
      total: facts.length,
      freshShown,
      freshTotal,
      heldCount,
      evaluatedAll: facts.length <= evaluated,
    };
  } catch {
    return empty; // a store read must never break the card
  }
}

/**
 * Render the session card for a project. When no map has been built yet, returns
 * a one-line hint instead. Reads the index cache and freshness-checks the
 * recorded findings; never scans the repository beyond the findings' cones.
 */
export function renderCard(options: StoreOptions, now: number = Date.now()): string {
  const cache = readIndexCache(options);
  if (cache === null) {
    return "Knowstone: no project map yet. Run the knowstone:map skill to build one, then knowstone:recall to retrieve verified findings.";
  }

  const findings = viewFindings(options, now);

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
  // Carry the still-current findings in the card itself, so the model has the
  // verified knowledge from turn one without choosing to run recall (the live
  // proof showed it often does not). Findings whose code changed are withheld and
  // only counted — the trust guarantee, delivered passively. Nothing stale is
  // ever shown here.
  if (findings.total === 0) {
    lines.push(
      `No verified findings recorded yet. Use knowstone:note to record a verified conclusion and knowstone:map to refresh the map.`,
    );
    return lines.join(" ");
  }

  if (findings.freshShown.length > 0) {
    lines.push("Verified findings for this project, still current (safe to rely on):");
    for (const statement of findings.freshShown) lines.push(`- ${statement}`);
    const moreFresh = findings.freshTotal - findings.freshShown.length;
    if (moreFresh > 0) {
      lines.push(
        `(+${moreFresh} more current finding(s); run knowstone:recall for the full list.)`,
      );
    }
  } else {
    lines.push("No currently-valid findings: every recorded one was held for re-verify (below).");
  }

  if (findings.heldCount > 0) {
    lines.push(
      `${findings.heldCount} finding(s) held for re-verify: their code changed since recording, so they are withheld here, not shown. Run knowstone:recall to review them against the current code.`,
    );
  }
  if (!findings.evaluatedAll) {
    lines.push(
      `(Only the first ${MAX_EVALUATED} findings were freshness-checked for this card; run knowstone:recall to see all.)`,
    );
  }
  lines.push(
    "Record new verified conclusions with knowstone:note; refresh the map with knowstone:map.",
  );
  return lines.join(" ");
}
