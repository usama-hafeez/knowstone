/**
 * Knowstone — command-line interface.
 *
 * The skills (knowstone:map / :note / :recall) and the SessionStart hook are thin
 * wrappers: they invoke this CLI and show its output. All the deterministic work
 * (indexing, cone binding, the freshness check) lives here and in the library
 * modules, never in model tokens. Everything is read-only against the project and
 * writes only to the plugin's own per-project data directory. See ../../../PLAN.md
 * (M4).
 *
 * Commands:
 *   map     build/refresh the Tier-A index (structure, routes, schema, scripts)
 *   note    record a verified finding, bound to the dependency cone of its evidence
 *   recall  list findings, freshness-checked; stale ones are held for re-verify
 *   card    print the tiny static session card (used by the SessionStart hook)
 *
 * Common flags: --data <dir> (plugin data dir, default $CLAUDE_PLUGIN_DATA),
 *   --project <dir> (repo root, default $CLAUDE_PROJECT_DIR or cwd).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KNOWSTONE_VERSION } from "./index.js";
import { buildIndex } from "./indexer.js";
import { extractStructure } from "./structure.js";
import { extractRoutes } from "./routes.js";
import { extractSchema } from "./schema.js";
import { extractScripts } from "./scripts.js";
import { snapshotRepo } from "./incremental.js";
import { buildBinding, checkFreshness } from "./freshness.js";
import { canonicalProjectRoot, openStore, projectKey, SecretError, } from "./store.js";
import { writeIndexCache } from "./cache.js";
import { renderCard } from "./card.js";
import { enforceCaps } from "./caps.js";
import { logEvent } from "./log.js";
/**
 * Minimal flag parser. Every CLI flag takes a value, in either form:
 *   --key value   (the next token is the value, even if it starts with "--",
 *                  so a statement or query like "--foo" is kept intact)
 *   --key=value   (unambiguous; required for a value that is itself "--" or empty)
 * A lone trailing `--key` with no following token is recorded as `true` (absent).
 */
function parseArgs(args) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const body = arg.slice(2);
            const eq = body.indexOf("=");
            if (eq !== -1) {
                flags[body.slice(0, eq)] = body.slice(eq + 1);
                continue;
            }
            const next = args[i + 1];
            if (next === undefined) {
                flags[body] = true;
            }
            else {
                flags[body] = next;
                i++;
            }
        }
        else {
            positionals.push(arg);
        }
    }
    return { flags, positionals };
}
function stringFlag(flags, key) {
    const value = flags[key];
    return typeof value === "string" ? value : null;
}
/** Resolve the StoreOptions (data dir + project root) for a command. */
function resolveStore(flags, env) {
    const baseDir = stringFlag(flags, "data") ?? env.baseDir;
    const projectRoot = canonicalProjectRoot(stringFlag(flags, "project") ?? env.cwd);
    return { baseDir, projectRoot };
}
/**
 * Record one freshness decision to the structured log (PLAN.md M5). Best-effort via
 * logEvent; logs the fact id, the status and reason, and how many cone files
 * changed — never the fact's statement text.
 */
function logFreshness(options, factId, result, at) {
    logEvent(options.baseDir, "freshness", {
        projectKey: projectKey(options.projectRoot),
        factId,
        status: result.status,
        reason: result.reason,
        changed: result.changed.length,
    }, at);
}
/** Format the language breakdown as "ts 100, php 20". */
function languageSummary(byLanguage) {
    const parts = Object.entries(byLanguage).map(([lang, count]) => `${lang} ${count}`);
    return parts.length > 0 ? parts.join(", ") : "none";
}
/**
 * Run one extractor in isolation. A thrown extractor must never abort the whole
 * map nor be reported as an empty (authoritative) result: on failure we record the
 * view name in `degraded` and return the given fallback, so the view is later shown
 * as "unknown, explore" rather than as a false fact. The engine never serves a guess.
 */
function safeExtract(name, fallback, degraded, run) {
    try {
        return run();
    }
    catch {
        degraded.push(name);
        return fallback;
    }
}
/** Empty structure summary used when the structure extractor itself fails. */
const EMPTY_STRUCTURE = {
    fileCount: 0,
    byLanguage: {},
    topLevelDirs: [],
    entryPoints: [],
};
function cmdMap(flags, env) {
    const options = resolveStore(flags, env);
    const index = buildIndex(options.projectRoot);
    const degraded = [];
    const structure = safeExtract("structure", EMPTY_STRUCTURE, degraded, () => extractStructure(index));
    const routes = safeExtract("routes", [], degraded, () => extractRoutes(index));
    const schema = safeExtract("schema", [], degraded, () => extractSchema(index));
    const scripts = safeExtract("scripts", [], degraded, () => extractScripts(index));
    const snapshot = snapshotRepo(index, KNOWSTONE_VERSION);
    const truncated = index.truncated ?? false;
    writeIndexCache(options, {
        toolVersion: KNOWSTONE_VERSION,
        builtAt: env.now,
        snapshot,
        structure,
        routes,
        schema,
        scripts,
        degraded,
        truncated,
    });
    // Keep Tier-A caches within budget (never evicts Tier-B findings).
    enforceCaps(options.baseDir, {}, env.now);
    // Report each view honestly: a count only when the extractor succeeded, and
    // "unknown" (never "0") for a view whose extractor failed.
    const degradedSet = new Set(degraded);
    const count = (name, n, label) => degradedSet.has(name) ? `unknown ${label}` : `${n} ${label}`;
    env.out(`Mapped ${options.projectRoot}`);
    if (degradedSet.has("structure")) {
        env.out("  source files: unknown (structure extractor failed; explore the repo)");
    }
    else {
        env.out(`  ${structure.fileCount} source files (${languageSummary(structure.byLanguage)})`);
    }
    env.out(`  ${count("routes", routes.length, "routes")}, ${count("schema", schema.length, "DB tables")}, ${count("scripts", scripts.length, "npm scripts")}, ${structure.entryPoints.length} entry points`);
    if (truncated) {
        env.out("  note: the repo exceeded the file cap, so this map covers only part of it. Treat it as incomplete.");
    }
    if (degraded.length > 0) {
        env.out(`  note: these views could not be derived and are unknown, not empty: ${degraded.join(", ")}. Explore them directly.`);
    }
    env.out("Map saved. Use knowstone:note to record a finding, knowstone:recall to retrieve.");
    return 0;
}
function cmdNote(flags, env) {
    const options = resolveStore(flags, env);
    const statement = (stringFlag(flags, "statement") ?? "").trim();
    if (statement === "") {
        env.err('note: --statement "<text>" is required');
        return 2;
    }
    const evidence = (stringFlag(flags, "evidence") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    if (evidence.length === 0) {
        env.err("note: --evidence <file[,file...]> is required (at least one evidence file)");
        return 2;
    }
    const ttlRaw = stringFlag(flags, "ttl");
    const ttlMs = ttlRaw !== null ? Number(ttlRaw) : undefined;
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
        env.err("note: --ttl must be a positive number of milliseconds");
        return 2;
    }
    const index = buildIndex(options.projectRoot);
    let binding;
    try {
        binding = buildBinding({ root: options.projectRoot, toolVersion: KNOWSTONE_VERSION, now: env.now }, evidence, index.graph, ttlMs !== undefined ? { ttlMs } : {});
    }
    catch (error) {
        env.err(`note: cannot bind evidence (${error.message})`);
        return 1;
    }
    const store = openStore(options);
    let fact;
    try {
        fact = store.put({ kind: "finding", statement, binding, createdAt: env.now });
    }
    catch (error) {
        if (error instanceof SecretError) {
            env.err(`note: refused — the statement looks like it contains secrets [${error.kinds.join(", ")}]`);
            return 1;
        }
        throw error;
    }
    const freshness = checkFreshness(fact.binding, {
        root: options.projectRoot,
        toolVersion: KNOWSTONE_VERSION,
        now: env.now,
    });
    logFreshness(options, fact.id, freshness, env.now);
    env.out(`Recorded finding [${fact.id}] bound to ${binding.cone.length} evidence file(s). Status: ${freshness.status}.`);
    if (!binding.coneComplete) {
        env.out("  note: the import graph for this cone is incomplete (unresolved imports), so recall will hold this finding for re-verification.");
    }
    return 0;
}
function cmdRecall(flags, env) {
    const options = resolveStore(flags, env);
    const store = openStore(options);
    const query = stringFlag(flags, "query");
    const needle = query !== null ? query.toLowerCase() : null;
    const facts = store
        .list()
        .filter((f) => needle === null || f.statement.toLowerCase().includes(needle));
    if (facts.length === 0) {
        const suffix = needle !== null ? " matching the query" : "";
        env.out(`No findings on record${suffix}. Use knowstone:note to record one.`);
        return 0;
    }
    const fresh = [];
    const hold = [];
    for (const fact of facts) {
        const result = checkFreshness(fact.binding, {
            root: options.projectRoot,
            toolVersion: KNOWSTONE_VERSION,
            now: env.now,
        });
        logFreshness(options, fact.id, result, env.now);
        if (result.status === "FRESH") {
            fresh.push(`  [${fact.id}] ${fact.statement}`);
        }
        else {
            hold.push(`  [${fact.id}] ${fact.statement}`);
            hold.push(`      ${result.status}: ${result.reason}`);
        }
    }
    env.out(`FRESH — safe to use (${fresh.length}):`);
    for (const line of fresh)
        env.out(line);
    env.out(`NEEDS RE-VERIFY — do not rely on these; confirm against the current code before using (${hold.length === 0 ? 0 : hold.length / 2}):`);
    for (const line of hold)
        env.out(line);
    return 0;
}
function cmdCard(flags, env) {
    env.out(renderCard(resolveStore(flags, env), env.now));
    return 0;
}
/**
 * Run one CLI invocation. Returns a process exit code (0 ok, 1 runtime error, 2
 * usage error). Never throws for an expected failure; unexpected errors are
 * caught and reported on stderr.
 */
export function runCli(argv, env) {
    const { flags, positionals } = parseArgs(argv);
    const command = positionals[0];
    try {
        switch (command) {
            case "map":
                return cmdMap(flags, env);
            case "note":
                return cmdNote(flags, env);
            case "recall":
                return cmdRecall(flags, env);
            case "card":
                return cmdCard(flags, env);
            default:
                env.err(`knowstone: unknown command "${command ?? ""}". Commands: map, note, recall, card.`);
                return 2;
        }
    }
    catch (error) {
        env.err(`knowstone: ${error.message}`);
        return 1;
    }
}
/** The default plugin data directory when neither --data nor the env var is set. */
function defaultBaseDir() {
    return (process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), ".claude", "plugins", "data", "knowstone"));
}
// Run as the CLI entry point, but not when imported (e.g. by tests).
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
    const env = {
        baseDir: defaultBaseDir(),
        cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
        now: Date.now(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
    };
    process.exit(runCli(process.argv.slice(2), env));
}
