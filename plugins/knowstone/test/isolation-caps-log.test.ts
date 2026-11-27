import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openStore,
  projectDir,
  ProjectCollisionError,
  type FactInput,
  type StoreOptions,
} from "../src/store.js";
import { readIndexCache } from "../src/cache.js";
import { enforceCaps, DEFAULT_MAX_TIER_A_BYTES } from "../src/caps.js";
import { logFilePath } from "../src/log.js";
import { runCli, type CliEnv } from "../src/cli.js";

/**
 * M5 isolation, caps and logging. Isolation must never let one project's data bleed
 * into another; caps must bound Tier-A while never touching Tier-B; the log must
 * record every freshness decision without leaking statements. See ../../../PLAN.md.
 */

const temps: string[] = [];

function tmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowstone-m5-"));
  temps.push(dir);
  return dir;
}

function input(statement: string): FactInput {
  return {
    kind: "finding",
    statement,
    binding: { toolVersion: "0.1.0", createdAt: 1, cone: [], coneRoot: "r", coneComplete: true },
    createdAt: 1,
  };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Per-project isolation
// ---------------------------------------------------------------------------

describe("per-project isolation: no cross-project bleed", () => {
  it("keeps two projects' facts fully separate under one data dir", () => {
    const base = tmpBase();
    const a = openStore({ baseDir: base, projectRoot: "/proj/alpha" });
    const b = openStore({ baseDir: base, projectRoot: "/proj/beta" });
    a.put(input("alpha-only finding"));
    b.put(input("beta-only finding"));

    expect(
      openStore({ baseDir: base, projectRoot: "/proj/alpha" })
        .list()
        .map((f) => f.statement),
    ).toEqual(["alpha-only finding"]);
    expect(
      openStore({ baseDir: base, projectRoot: "/proj/beta" })
        .list()
        .map((f) => f.statement),
    ).toEqual(["beta-only finding"]);
    // Distinct projects resolve to distinct data directories.
    expect(projectDir({ baseDir: base, projectRoot: "/proj/alpha" })).not.toBe(
      projectDir({ baseDir: base, projectRoot: "/proj/beta" }),
    );
  });

  it("writes an isolation marker recording the owning project", () => {
    const base = tmpBase();
    const options: StoreOptions = { baseDir: base, projectRoot: "/proj/gamma" };
    openStore(options).put(input("a finding"));
    const marker = JSON.parse(readFileSync(join(projectDir(options), "meta.json"), "utf8")) as {
      projectRoot: string;
    };
    expect(marker.projectRoot).toBe("/proj/gamma");
  });

  it("refuses to open a data dir whose marker names a different project (collision guard)", () => {
    const base = tmpBase();
    // A project's own data dir, but carrying a marker that claims a DIFFERENT owner
    // (this is exactly the on-disk state a hash collision would produce).
    const victim: StoreOptions = { baseDir: base, projectRoot: "/proj/victim" };
    const dir = projectDir(victim);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ projectRoot: "/proj/other-owner" }),
      "utf8",
    );

    // Opening the store must fail loudly rather than read/clobber the other owner.
    expect(() => openStore(victim)).toThrow(ProjectCollisionError);
  });

  it("returns a null cache (never a foreign one) when the marker names another project", () => {
    const base = tmpBase();
    const options: StoreOptions = { baseDir: base, projectRoot: "/proj/reader" };
    const dir = projectDir(options);
    mkdirSync(dir, { recursive: true });
    // A valid cache sits in the dir, but the marker says it belongs to someone else.
    writeFileSync(
      join(dir, "index-cache.json"),
      JSON.stringify({
        version: 2,
        toolVersion: "0.1.0",
        builtAt: 1,
        snapshot: { toolVersion: "0.1.0", files: {} },
        structure: { fileCount: 0, byLanguage: {}, topLevelDirs: [], entryPoints: [] },
        routes: [],
        schema: [],
        scripts: [],
        degraded: [],
        truncated: false,
      }),
      "utf8",
    );

    // Marker names a different owner -> the reader must get null, not the cache.
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ projectRoot: "/proj/true-owner" }),
      "utf8",
    );
    expect(readIndexCache(options)).toBeNull();

    // Marker matches -> the same cache now reads fine (proving null was the guard).
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ projectRoot: "/proj/reader" }), "utf8");
    expect(readIndexCache(options)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tier-A caps (LRU), Tier-B never evicted
// ---------------------------------------------------------------------------

describe("Tier-A cache caps evict LRU and never touch Tier-B", () => {
  function seedProject(base: string, key: string, cacheBytes: number, mtimeSec: number): string {
    const dir = join(base, "projects", key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index-cache.json"), "x".repeat(cacheBytes), "utf8");
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ version: 1, facts: [] }), "utf8");
    utimesSync(join(dir, "index-cache.json"), mtimeSec, mtimeSec);
    return dir;
  }

  it("evicts the oldest caches first until within budget, keeping every facts.json", () => {
    const base = tmpBase();
    // Four caches of 100 bytes each (400 total), distinct ages.
    const oldest = seedProject(base, "p-oldest", 100, 1000);
    const mid1 = seedProject(base, "p-mid1", 100, 2000);
    const mid2 = seedProject(base, "p-mid2", 100, 3000);
    const newest = seedProject(base, "p-newest", 100, 4000);

    // Budget 250 bytes -> must drop the two oldest (down to 200).
    const result = enforceCaps(base, { maxTierABytes: 250 }, 5000);

    expect(result.evicted).toEqual(["p-oldest", "p-mid1"]);
    expect(result.remainingBytes).toBe(200);
    // Evicted caches are gone...
    expect(existsSync(join(oldest, "index-cache.json"))).toBe(false);
    expect(existsSync(join(mid1, "index-cache.json"))).toBe(false);
    // ...newer caches remain.
    expect(existsSync(join(mid2, "index-cache.json"))).toBe(true);
    expect(existsSync(join(newest, "index-cache.json"))).toBe(true);
    // Tier-B facts.json is preserved for EVERY project, evicted or not.
    for (const dir of [oldest, mid1, mid2, newest]) {
      expect(existsSync(join(dir, "facts.json"))).toBe(true);
    }
  });

  it("does nothing when total Tier-A size is within budget", () => {
    const base = tmpBase();
    seedProject(base, "p1", 100, 1000);
    seedProject(base, "p2", 100, 2000);
    const result = enforceCaps(base, { maxTierABytes: 10_000 });
    expect(result.evicted).toEqual([]);
  });

  it("exposes a generous default budget", () => {
    expect(DEFAULT_MAX_TIER_A_BYTES).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Structured freshness logging
// ---------------------------------------------------------------------------

describe("structured JSONL logging of freshness decisions", () => {
  interface Fixture {
    root: string;
    baseDir: string;
    write: (rel: string, content: string) => void;
  }

  function makeFixture(): Fixture {
    const root = mkdtempSync(join(tmpdir(), "knowstone-log-proj-"));
    const baseDir = mkdtempSync(join(tmpdir(), "knowstone-log-data-"));
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
    return { root, baseDir, write };
  }

  function run(fx: Fixture, argv: string[], now: number): number {
    const env: CliEnv = {
      baseDir: fx.baseDir,
      cwd: fx.root,
      now,
      out: () => {},
      err: () => {},
    };
    return runCli(argv, env);
  }

  function readLog(baseDir: string): Array<Record<string, unknown>> {
    const file = logFilePath(baseDir);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("records a freshness decision per recall, with status but not the statement text", () => {
    const fx = makeFixture();
    const secretish = "login() hashes before comparing";
    run(fx, ["note", "--statement", secretish, "--evidence", "src/auth.ts"], 1000);
    run(fx, ["recall"], 2000);

    const events = readLog(fx.baseDir);
    const freshness = events.filter((e) => e.type === "freshness");
    expect(freshness.length).toBeGreaterThanOrEqual(2); // one at note, one at recall
    const recallEvent = freshness.find((e) => e.at === 2000);
    expect(recallEvent?.status).toBe("FRESH");
    expect(typeof recallEvent?.factId).toBe("string");
    expect(typeof recallEvent?.projectKey).toBe("string");
    // The log must not leak the fact's statement text.
    expect(readFileSync(logFilePath(fx.baseDir), "utf8")).not.toContain(secretish);
  });

  it("logs a STALE decision after the cone changes", () => {
    const fx = makeFixture();
    run(fx, ["note", "--statement", "auth note", "--evidence", "src/auth.ts"], 1000);
    fx.write("src/hash.ts", `export const hash = (s: string) => s.length + 1;\n`);
    run(fx, ["recall"], 3000);

    const stale = readLog(fx.baseDir).find((e) => e.type === "freshness" && e.at === 3000);
    expect(stale?.status).toBe("STALE");
    expect(typeof stale?.changed).toBe("number");
  });
});
