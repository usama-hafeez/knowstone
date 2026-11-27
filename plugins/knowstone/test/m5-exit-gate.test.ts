import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * M5 EXIT GATE — the fault-injection suite (PLAN.md M5 exit/verify).
 *
 * This file is the milestone's gate. It injects three classes of fault and asserts
 * the plugin degrades safely, keeping the two promises that matter:
 *   1. Corrupt the cache -> it SELF-HEALS and never destroys Tier-B findings.
 *   2. Two projects share one data dir -> NO cross-project data bleed.
 *   3. An extractor throws -> the map DEGRADES to "unknown", never serving a wrong
 *      fact, and never aborting the other views or corrupting stored findings.
 *
 * A failing extractor is injected for real, through the live `map` path, by mocking
 * the routes extractor to throw on demand.
 */

const h = vi.hoisted(() => ({ routesShouldThrow: false }));

vi.mock("../src/routes.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/routes.js")>();
  return {
    ...actual,
    extractRoutes: (index: Parameters<typeof actual.extractRoutes>[0]) => {
      if (h.routesShouldThrow) throw new Error("injected routes-extractor failure");
      return actual.extractRoutes(index);
    },
  };
});

// Imported after the mock is declared (vi.mock is hoisted above imports anyway).
const { runCli } = await import("../src/cli.js");
const { readIndexCache } = await import("../src/cache.js");
const { openStore, projectDir, canonicalProjectRoot } = await import("../src/store.js");
type CliEnv = import("../src/cli.js").CliEnv;

/** The canonical project root the CLI keys by for a fixture (mirrors resolveStore). */
function run0Root(fx: Fixture): string {
  return canonicalProjectRoot(fx.root);
}

const FIXED_NOW = 1_700_000_000_000;
const temps: string[] = [];

interface Fixture {
  root: string;
  baseDir: string;
  write: (rel: string, content: string) => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "knowstone-gate-proj-"));
  const baseDir = mkdtempSync(join(tmpdir(), "knowstone-gate-data-"));
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
  write("routes/web.php", `<?php\nRoute::get('/home', 'HomeController@index');\n`);
  write("package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }));
  write("db/schema.sql", `CREATE TABLE users (\n  id int,\n  email varchar(120)\n);\n`);
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

afterEach(() => {
  h.routesShouldThrow = false;
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Corrupt cache self-heals, never losing Tier-B
// ---------------------------------------------------------------------------

describe("exit gate: a corrupted cache self-heals and keeps Tier-B findings", () => {
  it("heals a corrupted fact store on the next write and preserves the bad bytes", () => {
    const fx = makeFixture();
    run(fx, ["note", "--statement", "the original finding", "--evidence", "src/auth.ts"]);

    // Corrupt the fact store on disk.
    const store = openStore({ baseDir: fx.baseDir, projectRoot: run0Root(fx) });
    const factsFile = store.path;
    writeFileSync(factsFile, "<<<not json>>>", "utf8");

    // A read degrades to empty without crashing or mutating the file.
    expect(run(fx, ["recall"]).out).toContain("No findings on record");

    // The next write heals the store and records the new finding.
    const noted = run(fx, [
      "note",
      "--statement",
      "the healed finding",
      "--evidence",
      "src/auth.ts",
    ]);
    expect(noted.code).toBe(0);
    expect(run(fx, ["recall"]).out).toContain("the healed finding");

    // The corrupt bytes were quarantined, not destroyed.
    const dir = join(factsFile, "..");
    const sidecars = readdirSync(dir).filter((n) => n.startsWith("facts.corrupt-"));
    expect(sidecars).toHaveLength(1);
  });

  it("rebuilds a corrupted index cache on the next map", () => {
    const fx = makeFixture();
    run(fx, ["map"]);
    const options = { baseDir: fx.baseDir, projectRoot: run0Root(fx) };
    writeFileSync(join(projectDir(options), "index-cache.json"), "}{ broken", "utf8");

    // Card degrades to the hint; a fresh map restores a valid cache.
    expect(run(fx, ["card"]).out).toContain("no project map yet");
    expect(run(fx, ["map"]).code).toBe(0);
    expect(readIndexCache(options)).not.toBeNull();
    expect(run(fx, ["card"]).out).toContain("Knowstone project map");
  });
});

// ---------------------------------------------------------------------------
// 2. No cross-project data bleed
// ---------------------------------------------------------------------------

describe("exit gate: no cross-project data bleed", () => {
  it("never serves one project's findings to another sharing the same data dir", () => {
    const fx = makeFixture();

    // A second project tree under the same plugin data dir.
    const otherRoot = mkdtempSync(join(tmpdir(), "knowstone-gate-other-"));
    temps.push(otherRoot);
    writeFileSync(join(otherRoot, "main.ts"), "export const main = 1;\n", "utf8");

    // Record a finding in project A.
    run(fx, ["note", "--statement", "A's secret design note", "--evidence", "src/auth.ts"]);

    // Project B (same baseDir, different root) must see nothing of A's.
    const bRecall = run({ ...fx, root: otherRoot }, ["recall", "--project", otherRoot]);
    expect(bRecall.out).toContain("No findings on record");
    expect(bRecall.out).not.toContain("A's secret design note");

    // Project A still has its own finding.
    expect(run(fx, ["recall"]).out).toContain("A's secret design note");
  });
});

// ---------------------------------------------------------------------------
// 3. A failing extractor degrades, never serving a wrong fact
// ---------------------------------------------------------------------------

describe("exit gate: a failing extractor degrades to unknown, never a wrong fact", () => {
  it("marks the failed view unknown, keeps the other views, and never aborts the map", () => {
    const fx = makeFixture();
    const options = { baseDir: fx.baseDir, projectRoot: run0Root(fx) };

    h.routesShouldThrow = true;
    const mapped = run(fx, ["map"]);
    expect(mapped.code).toBe(0); // the map does NOT crash

    // Routes is reported as UNKNOWN, never as a false "0 routes".
    expect(mapped.out).toContain("unknown routes");
    expect(mapped.out).not.toMatch(/\b0 routes\b/);
    expect(mapped.out).toContain("unknown, not empty: routes");

    // The other extractors still ran: their real counts are present.
    expect(mapped.out).toContain("1 DB tables");
    expect(mapped.out).toContain("2 npm scripts");

    // The persisted cache records the degraded view (so the card stays honest too).
    const cache = readIndexCache(options);
    expect(cache?.degraded).toContain("routes");
    expect(cache?.schema.length).toBe(1); // schema really was extracted
    expect(run(fx, ["card"]).out).toContain("unknown routes");
  });

  it("does not corrupt or wrongly serve stored findings when an extractor fails", () => {
    const fx = makeFixture();
    // A real, FRESH finding exists first.
    run(fx, ["note", "--statement", "auth hashes before compare", "--evidence", "src/auth.ts"]);
    expect(run(fx, ["recall"]).out).toContain("FRESH — safe to use (1):");

    // Now a map runs with a broken extractor.
    h.routesShouldThrow = true;
    expect(run(fx, ["map"]).code).toBe(0);
    h.routesShouldThrow = false;

    // Recall is unaffected: the finding is still served correctly (facts are Tier-B,
    // independent of the degraded Tier-A map), and nothing wrong is served.
    const recall = run(fx, ["recall"]);
    expect(recall.out).toContain("FRESH — safe to use (1):");
    expect(recall.out).toContain("auth hashes before compare");

    // And once an edit hits the cone, it is withheld as before.
    fx.write("src/hash.ts", `export const hash = (s: string) => s.length + 1;\n`);
    expect(run(fx, ["recall"]).out).toContain("NEEDS RE-VERIFY");
  });
});
