import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractRoutes } from "../src/routes.js";
import { extractSchema } from "../src/schema.js";
import { extractStructure } from "../src/structure.js";
import {
  buildSnapshot,
  dependentsOf,
  diffSnapshots,
  incrementalUpdate,
  planIncremental,
  snapshotRepo,
  type ExtractResult,
  type HashSnapshot,
} from "../src/incremental.js";

const TOOL = "test-engine-1";
const temps: string[] = [];

interface Repo {
  root: string;
  write: (rel: string, content: string) => void;
  remove: (rel: string) => void;
}

/** A small fixture: an a->b import chain, an independent route file c, plus SQL and a PHP migration. */
function makeRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "knowstone-incr-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  const remove = (rel: string): void => rmSync(join(root, rel), { force: true });

  write(
    "src/a.ts",
    `import { b } from "./b.js";\napp.get('/a', aHandler);\nexport const a = () => b;\n`,
  );
  write("src/b.ts", `export const b = 1;\n`);
  write("src/c.ts", `router.post('/c', cHandler);\n`);
  write("sql/init.sql", `CREATE TABLE widgets (\n  id int,\n  name varchar(50)\n);\n`);
  write(
    "migrations/m.php",
    `<?php\nSchema::create('gadgets', function (Blueprint $table) {\n  $table->id();\n  $table->string('title');\n});\n`,
  );
  return { root, write, remove };
}

/** Build the baseline: index, snapshot and the three extractor outputs, as a prior run would. */
function baseline(root: string): { snapshot: HashSnapshot; result: ExtractResult } {
  const index = buildIndex(root);
  const snapshot = snapshotRepo(index, TOOL);
  const result: ExtractResult = {
    structure: extractStructure(index),
    routes: extractRoutes(index),
    schema: extractSchema(index),
  };
  return { snapshot, result };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildSnapshot", () => {
  it("hashes files, sorts keys and is deterministic", () => {
    const { root } = makeRepo();
    const a = buildSnapshot(root, ["src/c.ts", "src/a.ts", "src/b.ts"], TOOL);
    const b = buildSnapshot(root, ["src/a.ts", "src/b.ts", "src/c.ts"], TOOL);
    expect(a).toEqual(b);
    expect(Object.keys(a.files)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(a.toolVersion).toBe(TOOL);
  });

  it("omits files that cannot be read rather than throwing", () => {
    const { root } = makeRepo();
    const snap = buildSnapshot(root, ["src/a.ts", "does/not/exist.ts"], TOOL);
    expect(Object.keys(snap.files)).toEqual(["src/a.ts"]);
  });
});

describe("diffSnapshots", () => {
  it("classifies added, removed, modified and unchanged, each sorted", () => {
    const prev: HashSnapshot = { toolVersion: TOOL, files: { x: "1", y: "2", z: "3" } };
    const curr: HashSnapshot = { toolVersion: TOOL, files: { y: "2", z: "9", w: "4" } };
    const diff = diffSnapshots(prev, curr);
    expect(diff.added).toEqual(["w"]);
    expect(diff.removed).toEqual(["x"]);
    expect(diff.modified).toEqual(["z"]);
    expect(diff.unchanged).toEqual(["y"]);
  });
});

describe("dependentsOf", () => {
  it("returns the reverse-reachable set and includes the changed files", () => {
    const { root } = makeRepo();
    const graph = buildIndex(root).graph; // a -> b
    expect([...dependentsOf(graph, ["src/b.ts"])].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect([...dependentsOf(graph, ["src/a.ts"])].sort()).toEqual(["src/a.ts"]);
  });

  it("terminates on an import cycle", () => {
    const graph = {
      edges: new Map([
        ["a", new Set(["b"])],
        ["b", new Set(["a"])],
      ]),
      incomplete: new Set<string>(),
    };
    expect([...dependentsOf(graph, ["a"])].sort()).toEqual(["a", "b"]);
  });
});

describe("planIncremental", () => {
  it("forces a full rebuild when the previous snapshot is empty", () => {
    const { root } = makeRepo();
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, { toolVersion: TOOL, files: {} }, current);
    expect(plan.fullRebuild).toBe(true);
    expect(plan.rerun).toEqual({ structure: true, routes: true, schema: true });
    // Every graph file is impacted on a full rebuild (migrations/m.php is a PHP index file).
    expect(plan.impactedFiles).toEqual(["migrations/m.php", "src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("forces a full rebuild when the engine version changed", () => {
    const { root } = makeRepo();
    const base = baseline(root);
    const index = buildIndex(root);
    const current = snapshotRepo(index, "test-engine-2");
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.fullRebuild).toBe(true);
  });

  it("maps a changed dependency to its dependents' cones, leaving unrelated files out", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("src/b.ts", `export const b = 2;\n`); // b is a's dependency
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.fullRebuild).toBe(false);
    // a imports b, so a's cone contains b: both are impacted. c is independent.
    expect(plan.impactedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.impactedFiles).not.toContain("src/c.ts");
  });

  it("maps a removed dependency to its still-present dependents via the augmented graph", () => {
    const { root, remove } = makeRepo();
    const base = baseline(root);
    remove("src/b.ts"); // a still imports "./b.js"
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.diff.removed).toContain("src/b.ts");
    // a depended on b, so a is impacted; b itself is gone and excluded.
    expect(plan.impactedFiles).toEqual(["src/a.ts"]);
  });

  it("an added file is impacted but seeds no spurious dependents", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("src/d.ts", `app.get('/d', dHandler);\n`);
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.impactedFiles).toEqual(["src/d.ts"]);
  });

  it("flags a present importer when an added file shadows its existing dependency", () => {
    const { root, write } = makeRepo();
    // f imports "./thing"; only thing.js exists, so the cone resolves to thing.js.
    write("src/f.ts", `import { t } from "./thing";\nexport const f = t;\n`);
    write("src/thing.js", `export const t = 1;\n`);
    const base = baseline(root);
    // Add thing.ts: ".ts" resolves before ".js", so f's real dependency flips to it.
    write("src/thing.ts", `export const t = 2;\n`);
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.diff.added).toContain("src/thing.ts");
    // f.ts is unchanged, but its cone silently changed, so it must be flagged.
    expect(plan.impactedFiles).toContain("src/f.ts");
    expect(plan.impactedFiles).toContain("src/thing.ts");
  });

  it("a SQL-only change re-runs schema alone", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("sql/init.sql", `CREATE TABLE widgets (\n  id int,\n  label varchar(20)\n);\n`);
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.rerun).toEqual({ structure: false, routes: false, schema: true });
    expect(plan.impactedFiles).toEqual([]); // .sql is not an import-graph node
  });

  it("a PHP migration change re-runs schema, routes and structure", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write(
      "migrations/m.php",
      `<?php\nSchema::create('gadgets', function (Blueprint $table) {\n  $table->id();\n  $table->string('name');\n});\n`,
    );
    const index = buildIndex(root);
    const current = snapshotRepo(index, TOOL);
    const plan = planIncremental(index, base.snapshot, current);
    expect(plan.rerun).toEqual({ structure: true, routes: true, schema: true });
  });
});

describe("incrementalUpdate", () => {
  it("re-extracts only the edited route file and keeps the others by reference", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("src/c.ts", `router.post('/c2', cHandler);\n`); // change c's own route

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });

    const paths = out.result.routes.map((r) => r.path).sort();
    expect(paths).toEqual(["/a", "/c2"]);
    // /a's route object was retained (not re-extracted): same reference as before.
    const prevA = base.result.routes.find((r) => r.path === "/a");
    const nowA = out.result.routes.find((r) => r.path === "/a");
    expect(nowA).toBe(prevA);
    // schema is untouched -> reused by reference. structure re-runs (a graph file
    // changed) so it is a fresh object, but its value is unchanged here.
    expect(out.result.schema).toBe(base.result.schema);
    expect(out.result.structure).toEqual(base.result.structure);
  });

  it("editing a dependency does not change route values but refreshes the snapshot", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("src/b.ts", `export const b = 99;\n`); // dependency of a, has no route of its own

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });

    // b is a route-language file, so routes re-run, but a's and c's routes are unchanged.
    expect(out.result.routes.map((r) => r.path).sort()).toEqual(["/a", "/c"]);
    const nowA = out.result.routes.find((r) => r.path === "/a");
    expect(nowA).toBe(base.result.routes.find((r) => r.path === "/a"));
    // The new snapshot records b's new hash.
    expect(out.snapshot.files["src/b.ts"]).not.toBe(base.snapshot.files["src/b.ts"]);
    expect(out.plan.impactedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("drops routes and tables for removed files", () => {
    const { root, remove } = makeRepo();
    const base = baseline(root);
    remove("src/c.ts");

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });
    expect(out.result.routes.some((r) => r.path === "/c")).toBe(false);
    expect(out.result.routes.some((r) => r.path === "/a")).toBe(true);
  });

  it("adds routes and tables for new files", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("src/d.ts", `app.get('/d', dHandler);\n`);
    write("sql/more.sql", `CREATE TABLE sprockets (\n  id int\n);\n`);

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });
    expect(out.result.routes.some((r) => r.path === "/d")).toBe(true);
    expect(out.result.schema.some((t) => t.table === "sprockets")).toBe(true);
    expect(out.result.schema.some((t) => t.table === "widgets")).toBe(true);
  });

  it("re-extracts the SQL schema but leaves routes and structure by reference", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("sql/init.sql", `CREATE TABLE widgets (\n  id int,\n  label varchar(20)\n);\n`);

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });
    expect(out.result.routes).toBe(base.result.routes); // unchanged by reference
    expect(out.result.structure).toBe(base.result.structure);
    const widgets = out.result.schema.find((t) => t.table === "widgets");
    expect(widgets?.columns.map((c) => c.name)).toEqual(["id", "label"]);
  });

  it("the incremental result equals a full re-extraction after the same edits", () => {
    const { root, write, remove } = makeRepo();
    const base = baseline(root);

    // A mix of add, modify and remove.
    write(
      "src/a.ts",
      `import { b } from "./b.js";\napp.get('/a', aHandler);\napp.put('/a2', a2);\n`,
    );
    write("src/e.ts", `fastify.get('/e', eHandler);\n`);
    remove("src/c.ts");
    write("sql/init.sql", `CREATE TABLE widgets (\n  id int,\n  name varchar(80)\n);\n`);

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });

    const fresh = buildIndex(root);
    const expected: ExtractResult = {
      structure: extractStructure(fresh),
      routes: extractRoutes(fresh),
      schema: extractSchema(fresh),
    };
    expect(out.result.routes).toEqual(expected.routes);
    expect(out.result.schema).toEqual(expected.schema);
    expect(out.result.structure).toEqual(expected.structure);
    // And the snapshot matches a fresh snapshot of the repo now.
    expect(out.snapshot).toEqual(snapshotRepo(fresh, TOOL));
  });

  it("does a full rebuild when the engine version changes, matching a fresh extraction", () => {
    const { root, write } = makeRepo();
    const base = baseline(root);
    write("src/c.ts", `router.post('/c-new', cHandler);\n`);

    const out = incrementalUpdate(root, base.snapshot, base.result, {
      toolVersion: "test-engine-2",
    });
    expect(out.plan.fullRebuild).toBe(true);

    const fresh = buildIndex(root);
    expect(out.result.routes).toEqual(extractRoutes(fresh));
    expect(out.snapshot.toolVersion).toBe("test-engine-2");
  });
});
