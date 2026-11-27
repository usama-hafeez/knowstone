import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliEnv } from "../src/cli.js";
import { cachePath, readIndexCache, writeIndexCache } from "../src/cache.js";
import { renderCard } from "../src/card.js";
import { canonicalProjectRoot, openStore, type StoreOptions } from "../src/store.js";
import { buildIndex, walkSourceFiles } from "../src/indexer.js";

/**
 * M5 degradation paths: the plugin must behave sanely when the world is hostile —
 * no git, a corrupt or partial cache, a pathological repo. The golden rule carries
 * over from the freshness engine: never serve a guess. A degraded view is reported
 * as UNKNOWN, never as an authoritative empty result, and precious Tier-B findings
 * are never silently discarded. See ../../../PLAN.md (M5).
 */

const FIXED_NOW = 1_700_000_000_000;
const temps: string[] = [];

interface Fixture {
  root: string;
  baseDir: string;
  write: (rel: string, content: string) => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "knowstone-degrade-proj-"));
  const baseDir = mkdtempSync(join(tmpdir(), "knowstone-degrade-data-"));
  temps.push(root, baseDir);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  write(
    "src/auth.ts",
    `import { hash } from "./hash.js";\nexport const login = () => hash("x");\n`,
  );
  write("src/hash.ts", `export const hash = (s: string) => s.length;\n`);
  write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));
  return { root, baseDir, write };
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

function run(fx: Fixture, argv: string[], now = FIXED_NOW): RunResult {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    baseDir: fx.baseDir,
    cwd: fx.root,
    now,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const code = runCli(argv, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function storeOptions(fx: Fixture): StoreOptions {
  return { baseDir: fx.baseDir, projectRoot: canonicalProjectRoot(fx.root) };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No git
// ---------------------------------------------------------------------------

describe("no-git repositories", () => {
  it("runs the full map -> note -> recall -> edit -> re-verify cycle with no .git", () => {
    const fx = makeFixture();
    // The engine never shells out to git; prove the whole flow works without one.
    expect(existsSync(join(fx.root, ".git"))).toBe(false);

    expect(run(fx, ["map"]).code).toBe(0);
    const noted = run(fx, [
      "note",
      "--statement",
      "login hashes before compare",
      "--evidence",
      "src/auth.ts",
    ]);
    expect(noted.code).toBe(0);
    expect(noted.out).toContain("Status: FRESH");

    expect(run(fx, ["recall"]).out).toContain("FRESH — safe to use (1):");

    // Edit inside the cone -> withheld, with no git available to consult.
    fx.write("src/hash.ts", `export const hash = (s: string) => s.length + 1;\n`);
    const after = run(fx, ["recall"]);
    expect(after.out).toContain("FRESH — safe to use (0):");
    expect(after.out).toContain("NEEDS RE-VERIFY");
  });
});

// ---------------------------------------------------------------------------
// Corrupt / partial fact store self-heals (never loses Tier-B)
// ---------------------------------------------------------------------------

describe("corrupt fact store self-heals without losing Tier-B findings", () => {
  it("quarantines an unparseable facts.json on the next write instead of overwriting it", () => {
    const fx = makeFixture();
    const options = storeOptions(fx);
    const dir = join(options.baseDir, "projects");
    mkdirSync(dir, { recursive: true });

    // Open once to create the project dir, then clobber facts.json with garbage.
    const first = openStore(options);
    first.put({
      kind: "finding",
      statement: "original finding",
      binding: {
        toolVersion: "0.1.0",
        createdAt: 1,
        cone: [{ path: "a.ts", hash: "h", size: 1 }],
        coneRoot: "r",
        coneComplete: true,
      },
      createdAt: 1,
    });
    const factsFile = first.path;
    const corruptBytes = "{ this is not valid json ::::";
    writeFileSync(factsFile, corruptBytes, "utf8");

    // Reopen (corruption detected) and write a new fact: the self-heal.
    const reopened = openStore(options);
    expect(reopened.list()).toHaveLength(0); // corrupt file yields no facts in memory
    reopened.put({
      kind: "finding",
      statement: "healed finding",
      binding: {
        toolVersion: "0.1.0",
        createdAt: 2,
        cone: [{ path: "a.ts", hash: "h", size: 1 }],
        coneRoot: "r",
        coneComplete: true,
      },
      createdAt: 2,
    });

    // facts.json is valid again and holds the new fact.
    const healed = openStore(options);
    expect(healed.list().map((f) => f.statement)).toEqual(["healed finding"]);

    // The corrupt bytes were preserved in a sidecar, not destroyed.
    const dirOfFacts = join(factsFile, "..");
    const sidecars = readdirSync(dirOfFacts).filter((n) => n.startsWith("facts.corrupt-"));
    expect(sidecars).toHaveLength(1);
    expect(readFileSync(join(dirOfFacts, sidecars[0] as string), "utf8")).toBe(corruptBytes);
  });

  it("recovers the valid facts from a partially corrupt file and preserves the original", () => {
    const fx = makeFixture();
    const options = storeOptions(fx);
    const store0 = openStore(options);
    const factsFile = store0.path;
    mkdirSync(join(factsFile, ".."), { recursive: true });

    // One good fact, one malformed entry (missing required fields).
    const good = {
      id: "11111111-1111-1111-1111-111111111111",
      kind: "finding",
      statement: "recoverable finding",
      binding: { toolVersion: "0.1.0", createdAt: 1, cone: [], coneRoot: "r", coneComplete: true },
      createdAt: 1,
      supersededBy: null,
    };
    const bad = { id: 42, nope: true };
    writeFileSync(factsFile, JSON.stringify({ version: 1, facts: [good, bad] }), "utf8");

    const store = openStore(options);
    // The recoverable fact is kept; the junk entry is dropped.
    expect(store.list().map((f) => f.statement)).toEqual(["recoverable finding"]);

    // A write quarantines the partially-corrupt original (it held the dropped entry).
    store.put({
      kind: "finding",
      statement: "added later",
      binding: { toolVersion: "0.1.0", createdAt: 2, cone: [], coneRoot: "r", coneComplete: true },
      createdAt: 2,
    });
    const sidecars = readdirSync(join(factsFile, "..")).filter((n) =>
      n.startsWith("facts.corrupt-"),
    );
    expect(sidecars).toHaveLength(1);
  });

  it("does not quarantine or mutate a healthy store on read", () => {
    const fx = makeFixture();
    const options = storeOptions(fx);
    const store = openStore(options);
    store.put({
      kind: "finding",
      statement: "healthy",
      binding: { toolVersion: "0.1.0", createdAt: 1, cone: [], coneRoot: "r", coneComplete: true },
      createdAt: 1,
    });
    // Reopen and only read.
    openStore(options).list();
    const sidecars = readdirSync(join(store.path, "..")).filter((n) =>
      n.startsWith("facts.corrupt-"),
    );
    expect(sidecars).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Corrupt index cache rebuilds
// ---------------------------------------------------------------------------

describe("corrupt Tier-A index cache self-heals", () => {
  it("treats an unparseable cache as absent and rebuilds on the next map", () => {
    const fx = makeFixture();
    const options = storeOptions(fx);
    const file = cachePath(options);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "}{ not json", "utf8");

    // Card degrades to the no-map hint rather than crashing.
    expect(run(fx, ["card"]).out).toContain("no project map yet");

    // Next map rebuilds a valid cache.
    expect(run(fx, ["map"]).code).toBe(0);
    expect(readIndexCache(options)).not.toBeNull();
    expect(run(fx, ["card"]).out).toContain("Knowstone project map");
  });

  it("rebuilds a cache written in an older format version", () => {
    const fx = makeFixture();
    const options = storeOptions(fx);
    const file = cachePath(options);
    mkdirSync(join(file, ".."), { recursive: true });
    // A well-formed v1 cache (previous format) must be rebuilt, not trusted.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        toolVersion: "0.0.1",
        builtAt: 1,
        snapshot: { toolVersion: "0.0.1", files: {} },
        structure: { fileCount: 0, byLanguage: {}, topLevelDirs: [], entryPoints: [] },
        routes: [],
        schema: [],
        scripts: [],
      }),
      "utf8",
    );
    expect(readIndexCache(options)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extractor failure degrades to "unknown", never a false empty result
// ---------------------------------------------------------------------------

describe("a degraded view is reported as unknown, not as empty", () => {
  it("renders 'unknown' for a degraded view and 'partial' for a truncated map", () => {
    const fx = makeFixture();
    const options = storeOptions(fx);
    writeIndexCache(options, {
      toolVersion: "0.1.0",
      builtAt: FIXED_NOW,
      snapshot: { toolVersion: "0.1.0", files: {} },
      structure: { fileCount: 3, byLanguage: { ts: 3 }, topLevelDirs: [], entryPoints: [] },
      routes: [],
      schema: [],
      scripts: [],
      degraded: ["routes"],
      truncated: true,
    });

    const card = renderCard(options);
    // The failed extractor's empty result must not read as "0 routes".
    expect(card).toContain("unknown routes");
    expect(card).not.toContain("0 routes");
    expect(card).toContain("partial");
    expect(card).toContain("unknown, not empty: routes");
  });
});

// ---------------------------------------------------------------------------
// Huge repo stays cheap (bounded walk)
// ---------------------------------------------------------------------------

describe("huge repo stays cheap via the file cap", () => {
  it("stops walking at maxFiles and flags the index as truncated", () => {
    const fx = makeFixture();
    for (let i = 0; i < 40; i++) {
      fx.write(`gen/f${i}.ts`, `export const v${i} = ${i};\n`);
    }
    const capped = walkSourceFiles(fx.root, { maxFiles: 5 });
    expect(capped.files).toHaveLength(5);
    expect(capped.truncated).toBe(true);

    const full = walkSourceFiles(fx.root, { maxFiles: 10_000 });
    expect(full.truncated).toBe(false);
    expect(full.files.length).toBeGreaterThan(5);

    // buildIndex surfaces the same flag so the map can be marked incomplete.
    expect(buildIndex(fx.root, { maxFiles: 5 }).truncated).toBe(true);
    expect(buildIndex(fx.root, { maxFiles: 10_000 }).truncated).toBe(false);
  });
});
