import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliEnv } from "../src/cli.js";
import { cachePath } from "../src/cache.js";
import { canonicalProjectRoot } from "../src/store.js";

const FIXED_NOW = 1_700_000_000_000;
const temps: string[] = [];

interface Fixture {
  root: string;
  baseDir: string;
  write: (rel: string, content: string) => void;
}

/** A small TS app: auth.ts imports hash.ts; unrelated.ts is independent. */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "knowstone-cli-proj-"));
  const baseDir = mkdtempSync(join(tmpdir(), "knowstone-cli-data-"));
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
  write("src/unrelated.ts", `export const other = 1;\n`);
  write("package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
  write("db/schema.sql", `CREATE TABLE users (\n  id int,\n  email varchar(120)\n);\n`);
  return { root, baseDir, write };
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

function run(fixture: Fixture, argv: string[], now = FIXED_NOW): RunResult {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    baseDir: fixture.baseDir,
    cwd: fixture.root,
    now,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const code = runCli(argv, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli: map", () => {
  it("indexes the project, writes the cache, and reports the counts", () => {
    const fx = makeFixture();
    const { code, out } = run(fx, ["map"]);
    expect(code).toBe(0);
    expect(out).toContain("3 source files (ts 3)");
    expect(out).toContain("1 DB tables");
    expect(out).toContain("2 npm scripts");
    // The CLI keys the store by the canonical project root (resolves tmp short names).
    const options = { baseDir: fx.baseDir, projectRoot: canonicalProjectRoot(fx.root) };
    expect(existsSync(cachePath(options))).toBe(true);
  });
});

describe("cli: note + recall (the freshness end-to-end)", () => {
  it("records a finding and recalls it as FRESH, then holds it after its cone changes", () => {
    const fx = makeFixture();

    const noted = run(fx, [
      "note",
      "--statement",
      "login() hashes the password before comparing",
      "--evidence",
      "src/auth.ts",
    ]);
    expect(noted.code).toBe(0);
    expect(noted.out).toMatch(
      /Recorded finding \[[0-9a-f-]+\] bound to 2 evidence file\(s\)\. Status: FRESH\./,
    );

    // Recall: the finding is served as FRESH.
    const before = run(fx, ["recall"]);
    expect(before.code).toBe(0);
    expect(before.out).toContain("FRESH — safe to use (1):");
    expect(before.out).toContain("login() hashes the password before comparing");

    // Edit a file INSIDE the cone (hash.ts is imported by auth.ts).
    fx.write("src/hash.ts", `export const hash = (s: string) => s.length + 1;\n`);

    const after = run(fx, ["recall"]);
    expect(after.code).toBe(0);
    // The finding must now be withheld for re-verification, not served.
    expect(after.out).toContain("FRESH — safe to use (0):");
    expect(after.out).toContain("NEEDS RE-VERIFY");
    expect(after.out).toContain("login() hashes the password before comparing");
    expect(after.out).toMatch(/STALE: evidence changed:.*hash\.ts/);
  });

  it("keeps a finding FRESH when an unrelated file changes", () => {
    const fx = makeFixture();
    run(fx, ["note", "--statement", "auth flow note", "--evidence", "src/auth.ts"]);

    fx.write("src/unrelated.ts", `export const other = 2;\n`); // not in auth's cone

    const after = run(fx, ["recall"]);
    expect(after.out).toContain("FRESH — safe to use (1):");
    expect(after.out).toContain("auth flow note");
  });

  it("filters recall by --query, in both --query value and --query=value forms", () => {
    const fx = makeFixture();
    run(fx, ["note", "--statement", "alpha finding", "--evidence", "src/auth.ts"]);
    run(fx, ["note", "--statement", "beta finding", "--evidence", "src/hash.ts"]);

    const spaced = run(fx, ["recall", "--query", "beta"]);
    expect(spaced.out).toContain("beta finding");
    expect(spaced.out).not.toContain("alpha finding");

    const equals = run(fx, ["recall", "--query=alpha"]);
    expect(equals.out).toContain("alpha finding");
    expect(equals.out).not.toContain("beta finding");
  });

  it("keeps a flag value that begins with -- instead of dropping it", () => {
    const fx = makeFixture();
    // A statement starting with "--" must be recorded verbatim, not swallowed.
    const noted = run(fx, [
      "note",
      "--statement",
      "--legacy flag behaviour is intentional here",
      "--evidence",
      "src/auth.ts",
    ]);
    expect(noted.code).toBe(0);
    expect(run(fx, ["recall"]).out).toContain("--legacy flag behaviour is intentional here");
  });
});

describe("cli: note guards", () => {
  it("refuses to store a finding whose statement looks like it contains a secret", () => {
    const fx = makeFixture();
    const result = run(fx, [
      "note",
      "--statement",
      "the fix hard-codes AKIAIOSFODNN7EXAMPLE as the key",
      "--evidence",
      "src/auth.ts",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("refused");
    // Nothing was stored.
    expect(run(fx, ["recall"]).out).toContain("No findings on record");
  });

  it("errors with usage code 2 when --statement or --evidence is missing", () => {
    const fx = makeFixture();
    expect(run(fx, ["note", "--evidence", "src/auth.ts"]).code).toBe(2);
    expect(run(fx, ["note", "--statement", "x"]).code).toBe(2);
  });

  it("reports a clear error when an evidence file does not exist", () => {
    const fx = makeFixture();
    const result = run(fx, ["note", "--statement", "x", "--evidence", "src/nope.ts"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot bind evidence");
  });
});

describe("cli: card", () => {
  it("shows a hint before a map, then a summary with no findings yet", () => {
    const fx = makeFixture();
    expect(run(fx, ["card"]).out).toContain("no project map yet");

    run(fx, ["map"]);
    const card = run(fx, ["card"]).out;
    expect(card).toContain("Knowstone project map");
    expect(card).toContain("No verified findings recorded yet");
  });

  it("carries a current finding in the card and withholds it once its code changes", () => {
    const fx = makeFixture();
    run(fx, ["map"]);
    run(fx, [
      "note",
      "--statement",
      "Login hashing uses a 64-char token digest",
      "--evidence",
      "src/auth.ts",
    ]);

    // FRESH: the card delivers the verified finding's text directly, so the model
    // has it from turn one without having to run recall.
    const fresh = run(fx, ["card"]).out;
    expect(fresh).toContain("still current");
    expect(fresh).toContain("Login hashing uses a 64-char token digest");

    // Change the evidence file: the finding must be HELD and its text withheld —
    // the trust guarantee, delivered passively. The stale statement never appears.
    fx.write(
      "src/auth.ts",
      `import { hash } from "./hash.js";\nexport const login = () => hash("y");\n`,
    );
    const stale = run(fx, ["card"]).out;
    expect(stale).not.toContain("Login hashing uses a 64-char token digest");
    expect(stale).toContain("held for re-verify");
  });

  it("treats a partial/corrupt cache as absent rather than crashing", () => {
    const fx = makeFixture();
    const options = { baseDir: fx.baseDir, projectRoot: canonicalProjectRoot(fx.root) };
    const file = cachePath(options);
    mkdirSync(join(file, ".."), { recursive: true });
    // A version-valid but structurally incomplete cache must not crash `card`.
    writeFileSync(file, JSON.stringify({ version: 1, builtAt: 123, snapshot: {} }), "utf8");

    const result = run(fx, ["card"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("no project map yet");
  });
});

describe("cli: dispatch", () => {
  it("returns usage code 2 for an unknown command", () => {
    const fx = makeFixture();
    const result = run(fx, ["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command");
  });
});
