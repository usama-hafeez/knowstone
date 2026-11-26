import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportGraph } from "../src/imports.js";
import { buildBinding, checkFreshness, type Binding, type RepoSnapshot } from "../src/freshness.js";

/**
 * Each test builds a tiny throwaway repo on disk, binds a fact to a file, then
 * mutates the repo and asserts the fact is withheld. The headline test is the M1
 * gate: editing a transitive dependency mid-session must withhold the fact.
 */

const temps: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-fresh-"));
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

describe("M1 gate: a change withholds the dependent fact", () => {
  it("withholds the fact when a TRANSITIVE dependency is edited mid-session", () => {
    // a.ts imports b.ts; the fact is derived from a.ts, so its cone is {a,b}.
    const root = makeRepo({
      "a.ts": `import { b } from "./b.js";\nexport const a = () => b();\n`,
      "b.ts": `export const b = () => 1;\n`,
    });
    const graph = buildImportGraph(root, ["a.ts", "b.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);

    // The cone really did pick up the transitive dependency.
    expect(binding.cone.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);

    const snapshot: RepoSnapshot = { root, ...BASE };
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");

    // Edit the DEPENDENCY, not the file the fact was read from.
    appendFileSync(join(root, "b.ts"), "// changed\n", "utf8");

    const after = checkFreshness(binding, snapshot);
    expect(after.status).toBe("STALE");
    expect(after.changed).toContain("b.ts");
  });

  it("withholds when the directly-read file is edited", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");

    appendFileSync(join(root, "a.ts"), "export const extra = 2;\n", "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("STALE");
  });

  it("withholds when an evidence file is deleted", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph);
    const snapshot: RepoSnapshot = { root, ...BASE };

    rmSync(join(root, "a.ts"));
    const after = checkFreshness(binding, snapshot);
    expect(after.status).toBe("STALE");
    expect(after.changed).toContain("a.ts");
  });
});

describe("check order", () => {
  function simpleBinding(root: string): Binding {
    const graph = buildImportGraph(root, ["a.ts"]);
    return buildBinding({ root, ...BASE }, ["a.ts"], graph);
  }

  it("UNKNOWN when the engine version changed", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const binding = simpleBinding(root);
    const result = checkFreshness(binding, { root, toolVersion: "0.2.0", now: BASE.now });
    expect(result.status).toBe("UNKNOWN");
  });

  it("STALE when the TTL has expired, even if nothing changed", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph, { ttlMs: 1000 });
    const result = checkFreshness(binding, { root, toolVersion: "0.1.0", now: BASE.now + 5000 });
    expect(result.status).toBe("STALE");
  });

  it("UNKNOWN in strict mode when the cone is known-incomplete", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding({ root, ...BASE }, ["a.ts"], graph, { coneComplete: false });
    const snapshot: RepoSnapshot = { root, ...BASE };
    expect(checkFreshness(binding, snapshot).status).toBe("UNKNOWN");
    // Non-strict callers accept best-effort and get FRESH when unchanged.
    expect(checkFreshness(binding, snapshot, { strict: false }).status).toBe("FRESH");
  });
});

describe("git metadata is recorded but not yet trusted (fast-path deferred to M2)", () => {
  it("records the gitCommit on the binding", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding(
      { root, toolVersion: "0.1.0", now: BASE.now, gitCommit: "abc123" },
      ["a.ts"],
      graph,
    );
    expect(binding.gitCommit).toBe("abc123");
  });

  it("a dirty cone file is caught even when a caller claims the cone is clean", () => {
    const root = makeRepo({ "a.ts": `export const a = 1;\n` });
    const graph = buildImportGraph(root, ["a.ts"]);
    const binding = buildBinding(
      { root, toolVersion: "0.1.0", now: BASE.now, gitCommit: "abc123" },
      ["a.ts"],
      graph,
    );

    // Edit the file but claim the cone is clean: the flag is not honoured in M1.
    appendFileSync(join(root, "a.ts"), "// dirty\n", "utf8");
    const result = checkFreshness(binding, {
      root,
      toolVersion: "0.1.0",
      now: BASE.now,
      gitCommit: "abc123",
      gitCleanForCone: true,
    });
    expect(result.status).toBe("STALE");
    expect(result.changed).toContain("a.ts");
  });
});
