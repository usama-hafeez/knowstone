import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportGraph } from "../src/imports.js";
import { buildBinding, checkFreshness, type RepoSnapshot } from "../src/freshness.js";

/**
 * RED-TEAM probes. Each test encodes the SAFE expectation: for any case where a
 * dependency that was actually edited should withhold the fact, we assert STALE
 * (or UNKNOWN). A test that FAILS therefore marks a real hole: the engine said
 * FRESH when it must not have.
 *
 * The recurring mechanism behind the dangerous holes: buildBinding defaults
 * coneComplete to TRUE, so whenever import extraction or resolution silently
 * drops a real dependency, the cone is incomplete but the binding claims it is
 * complete. In strict mode nothing withholds, and re-hashing the (incomplete)
 * cone finds no change, so the fact is served FRESH.
 */

const temps: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-adv-"));
  temps.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, "utf8");
  }
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = { toolVersion: "0.1.0", now: 1_000_000 };

// ---------------------------------------------------------------------------
// GROUP 1 — extractImports / resolution false negatives -> false FRESH
// ---------------------------------------------------------------------------

describe("extraction/resolution false negatives (should withhold, dangerous if FRESH)", () => {
  it("template-literal dynamic import `import(`./b.js`)` must still track b.ts", () => {
    // The callRe only matches single/double quotes, not backticks, so this
    // dependency is never captured. buildBinding still claims coneComplete.
    const root = makeRepo({
      "a.ts": "export const a = async () => (await import(`./b.js`)).b();\n",
      "b.ts": `export const b = () => 1;\n`,
    });
    const graph = buildImportGraph(root, ["a.ts", "b.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");

    // Edit the real (template-imported) dependency.
    appendFileSync(join(root, "b.ts"), "// changed\n", "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("STALE");
  });

  it("TS path-alias import `@/b` must still track b.ts (or withhold)", () => {
    // A tsconfig-style alias. The specifier is captured but dropped because it
    // is not relative, so b is never in the cone. coneComplete defaults true.
    const root = makeRepo({
      "a.ts": `import { b } from "@/b";\nexport const a = () => b();\n`,
      "b.ts": `export const b = () => 1;\n`,
    });
    const graph = buildImportGraph(root, ["a.ts", "b.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };

    appendFileSync(join(root, "b.ts"), "// changed\n", "utf8");
    // Safe outcome: this change must be caught (STALE), or the cone should have
    // been flagged incomplete (UNKNOWN). FRESH here is the dangerous failure.
    expect(checkFreshness(binding, snapshot).status).not.toBe("FRESH");
  });

  it("case-differing relative import `./B.js` (resolves on Windows) must track b.ts", () => {
    // On a case-insensitive filesystem `./B.js` resolves to b.ts at runtime, but
    // fileSet.has('B.ts') is a case-sensitive JS lookup, so the edge is dropped.
    const root = makeRepo({
      "a.ts": `import { b } from "./B.js";\nexport const a = () => b();\n`,
      "b.ts": `export const b = () => 1;\n`,
    });
    const graph = buildImportGraph(root, ["a.ts", "b.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };

    appendFileSync(join(root, "b.ts"), "// changed\n", "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("STALE");
  });
});

// ---------------------------------------------------------------------------
// GROUP 2 — evidence-path normalisation -> false FRESH
// ---------------------------------------------------------------------------

describe("evidence path normalisation", () => {
  it("evidence given as `./a.ts` must still pull in a.ts's dependency b.ts", () => {
    // dependencyCone normalises with toPosix only (no path.posix.normalize), so
    // `./a.ts` does not match the graph key `a.ts`; the cone collapses to just
    // {`./a.ts`} and omits b.ts entirely, while coneComplete stays true.
    const root = makeRepo({
      "a.ts": `import { b } from "./b.js";\nexport const a = () => b();\n`,
      "b.ts": `export const b = () => 1;\n`,
    });
    const graph = buildImportGraph(root, ["a.ts", "b.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["./a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    // Sanity: the direct file still hashes fine so the fact reads FRESH to start.
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");

    appendFileSync(join(root, "b.ts"), "// changed\n", "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("STALE");
  });
});

// ---------------------------------------------------------------------------
// GROUP 3 — empty cone
// ---------------------------------------------------------------------------

describe("empty cone", () => {
  it("a binding with no evidence files is not provable and must not be FRESH forever", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, [], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    // An empty-evidence fact can never go stale; safest is to withhold it.
    expect(checkFreshness(binding, snapshot).status).not.toBe("FRESH");
  });
});

// ---------------------------------------------------------------------------
// GROUP 4 — git fast-path trust (contract finding)
// ---------------------------------------------------------------------------

describe("git fast-path trusts the gitCleanForCone flag with no second line of defence", () => {
  it("a wrongly-asserted clean flag short-circuits past a real edit", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding(
      { root, toolVersion: "0.1.0", now: BASE.now, gitCommit: "abc123" },
      ["a.ts"],
      graph,
    );
    // Really edit the file, but the caller (wrongly) says the cone is clean.
    appendFileSync(join(root, "a.ts"), "// edited after commit\n", "utf8");
    const result = checkFreshness(binding, {
      root,
      toolVersion: "0.1.0",
      now: BASE.now,
      gitCommit: "abc123",
      gitCleanForCone: true,
    });
    // Safe would be STALE; the engine trusts the flag and never re-hashes.
    expect(result.status).toBe("STALE");
  });
});

// ---------------------------------------------------------------------------
// GROUP 5 — things that SHOULD be correct (these are expected to PASS). They
// pin down where the engine is sound so the report does not overstate.
// ---------------------------------------------------------------------------

describe("control cases: the engine is expected to be correct here", () => {
  it("touching mtime without changing content stays FRESH (no thrash)", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    // Rewrite identical bytes (new mtime, same content).
    writeFileSync(join(root, "a.ts"), `export const a = 1;\n`, "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");
  });

  it("same-size content change is caught by the hash (STALE)", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    // Replace with identical byte length but different content (1 -> 2).
    writeFileSync(join(root, "a.ts"), `export const a = 2;\n`, "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("STALE");
  });

  it("delete-then-recreate with identical content stays FRESH", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    rmSync(join(root, "a.ts"));
    writeFileSync(join(root, "a.ts"), `export const a = 1;\n`, "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");
  });

  it("deep deleted dependency is caught (STALE)", () => {
    const root = makeRepo({
      "a.ts": `import { b } from "./b.js";\nexport const a = () => b();\n`,
      "b.ts": `import { c } from "./c.js";\nexport const b = () => c();\n`,
      "c.ts": `export const c = () => 1;\n`,
    });
    const graph = buildImportGraph(root, ["a.ts", "b.ts", "c.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    expect(binding.cone.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    const snapshot: RepoSnapshot = { root, ...BASE };
    rmSync(join(root, "c.ts"));
    const after = checkFreshness(binding, snapshot);
    expect(after.status).toBe("STALE");
    expect(after.changed).toContain("c.ts");
  });

  it("TTL boundary: now - createdAt EXACTLY equals ttlMs is treated as not expired", () => {
    // Documents the strict `>` boundary. Not dangerous (content is unchanged),
    // recorded so the behaviour is pinned, not a bug claim.
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph, { ttlMs: 1000 });
    const result = checkFreshness(binding, {
      root,
      toolVersion: "0.1.0",
      now: BASE.now + 1000,
    });
    expect(result.status).toBe("FRESH");
  });
});
