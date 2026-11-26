/**
 * M3 exit gate (PLAN.md §3, M3 "Exit/verify").
 *
 * Builds a small, known Node/TS + Laravel fixture repo, indexes it, runs all
 * three extractors, and spot-checks routes, DB tables and entry points against
 * the fixture's documented reality. Then it proves the incremental path: editing
 * one file re-extracts only the right module(s) and leaves unrelated facts
 * untouched (asserted by reference identity, so "untouched" means literally not
 * recomputed).
 *
 * The fixture's ground truth, by construction below:
 *
 *   src/server.ts                    imports routes/users + routes/health; no routes of its own; nothing imports it -> ENTRY POINT
 *   src/routes/users.ts              imports db/repo; GET /users, POST /users
 *   src/routes/health.ts             GET /health
 *   src/db/repo.ts                   imports db/models; no routes
 *   src/db/models.ts                 leaf; no imports; no routes
 *   database/migrations/..._users.php  Schema::create('users', ...) -> id, name, email, created_at, updated_at; nothing imports it -> ENTRY POINT
 *   database/schema.sql              CREATE TABLE sessions -> id, user_id, token
 *
 *   Import chain: server -> {users -> repo -> models, health}
 *   Entry points (no incoming import edge): database/migrations/..._users.php, src/server.ts
 *   Routes: GET /health, GET /users, POST /users
 *   Tables: sessions(id,user_id,token), users(id,name,email,created_at,updated_at)
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractRoutes } from "../src/routes.js";
import { extractSchema } from "../src/schema.js";
import { extractStructure } from "../src/structure.js";
import {
  incrementalUpdate,
  snapshotRepo,
  type ExtractResult,
  type HashSnapshot,
} from "../src/incremental.js";

const TOOL = "m3-gate-1";
const MIGRATION = "database/migrations/2024_01_01_000000_create_users_table.php";
const temps: string[] = [];

function makeFixture(): { root: string; write: (rel: string, content: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "knowstone-m3-gate-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };

  write(
    "src/server.ts",
    [
      `import { userRoutes } from "./routes/users.js";`,
      `import { healthRoutes } from "./routes/health.js";`,
      `const app = makeApp();`,
      `userRoutes(app);`,
      `healthRoutes(app);`,
      `app.listen(3000);`,
      ``,
    ].join("\n"),
  );
  write(
    "src/routes/users.ts",
    [
      `import { repo } from "../db/repo.js";`,
      `export function userRoutes(router) {`,
      `  router.get('/users', listUsers);`,
      `  router.post('/users', createUser);`,
      `  return repo;`,
      `}`,
      ``,
    ].join("\n"),
  );
  write(
    "src/routes/health.ts",
    [
      `export function healthRoutes(router) {`,
      `  router.get('/health', healthHandler);`,
      `}`,
      ``,
    ].join("\n"),
  );
  write(
    "src/db/repo.ts",
    [`import { User } from "./models.js";`, `export const repo = { User };`, ``].join("\n"),
  );
  write("src/db/models.ts", [`export class User {}`, ``].join("\n"));
  write(
    MIGRATION,
    [
      `<?php`,
      `Schema::create('users', function (Blueprint $table) {`,
      `  $table->id();`,
      `  $table->string('name');`,
      `  $table->string('email');`,
      `  $table->timestamps();`,
      `});`,
      ``,
    ].join("\n"),
  );
  write(
    "database/schema.sql",
    [
      `CREATE TABLE sessions (`,
      `  id int,`,
      `  user_id int,`,
      `  token varchar(64)`,
      `);`,
      ``,
    ].join("\n"),
  );
  return { root, write };
}

function baseline(root: string): { snapshot: HashSnapshot; result: ExtractResult } {
  const index = buildIndex(root);
  return {
    snapshot: snapshotRepo(index, TOOL),
    result: {
      structure: extractStructure(index),
      routes: extractRoutes(index),
      schema: extractSchema(index),
    },
  };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("M3 exit gate — index a known fixture and match reality", () => {
  it("structure: counts, language mix and entry points match the fixture", () => {
    const structure = extractStructure(buildIndex(makeFixture().root));

    // 5 .ts + 1 .php are index files; the .sql is not part of the import graph.
    expect(structure.fileCount).toBe(6);
    expect(structure.byLanguage).toEqual({ ts: 5, php: 1 });

    // Entry points = files nothing imports: the server and the migration.
    expect(structure.entryPoints).toEqual([MIGRATION, "src/server.ts"]);
    // A file that IS imported must never be an entry point.
    expect(structure.entryPoints).not.toContain("src/db/models.ts");
    expect(structure.entryPoints).not.toContain("src/routes/users.ts");
  });

  it("routes: every declared route is found, and nothing spurious", () => {
    const routes = extractRoutes(buildIndex(makeFixture().root));

    const simplified = routes
      .map((r) => `${r.method} ${r.path} -> ${r.handler} @ ${r.file}`)
      .sort();
    expect(simplified).toEqual([
      "GET /health -> healthHandler @ src/routes/health.ts",
      "GET /users -> listUsers @ src/routes/users.ts",
      "POST /users -> createUser @ src/routes/users.ts",
    ]);
  });

  it("schema: Laravel migration and SQL tables match, with their columns", () => {
    const tables = extractSchema(buildIndex(makeFixture().root));

    expect(tables.map((t) => t.table)).toEqual(["sessions", "users"]);

    // Names AND types are pinned to the fixture reality (timestamps() expands to
    // two timestamp columns; the SQL types carry their declared size).
    const users = tables.find((t) => t.table === "users");
    expect(users?.columns).toEqual([
      { name: "id", type: "id" },
      { name: "name", type: "string" },
      { name: "email", type: "string" },
      { name: "created_at", type: "timestamp" },
      { name: "updated_at", type: "timestamp" },
    ]);

    const sessions = tables.find((t) => t.table === "sessions");
    expect(sessions?.columns).toEqual([
      { name: "id", type: "int" },
      { name: "user_id", type: "int" },
      { name: "token", type: "varchar(64)" },
    ]);
  });
});

describe("M3 exit gate — incremental path re-extracts only the right module(s)", () => {
  it("editing a route file re-extracts just that file; unrelated routes retained by reference", () => {
    const { root, write } = makeFixture();
    const base = baseline(root);

    // Change only health.ts's own route path.
    write(
      "src/routes/health.ts",
      [
        `export function healthRoutes(router) {`,
        `  router.get('/healthz', healthHandler);`,
        `}`,
        ``,
      ].join("\n"),
    );

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });

    // The route value changed exactly where expected.
    expect(out.result.routes.some((r) => r.path === "/healthz")).toBe(true);
    expect(out.result.routes.some((r) => r.path === "/health")).toBe(false);

    // The users routes were NOT re-extracted: same object references as before.
    const prevGetUsers = base.result.routes.find((r) => r.method === "GET" && r.path === "/users");
    const nowGetUsers = out.result.routes.find((r) => r.method === "GET" && r.path === "/users");
    expect(nowGetUsers).toBe(prevGetUsers);

    // Schema touched nothing (no php/sql changed) -> reused by reference.
    expect(out.result.schema).toBe(base.result.schema);

    // Cone impact: health.ts and its importer server.ts, and nothing else.
    expect(out.plan.impactedFiles).toEqual(["src/routes/health.ts", "src/server.ts"]);
    expect(out.plan.rerun).toEqual({ structure: true, routes: true, schema: false });
  });

  it("editing a deep leaf flags its whole dependent chain but leaves route/schema values intact", () => {
    const { root, write } = makeFixture();
    const base = baseline(root);

    // models.ts is imported by repo -> users -> server. It declares no routes.
    write("src/db/models.ts", [`export class User {`, `  id = 0;`, `}`, ``].join("\n"));

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });

    // Cone propagates up the import chain, but NOT across to the health branch.
    expect(out.plan.impactedFiles).toEqual([
      "src/db/models.ts",
      "src/db/repo.ts",
      "src/routes/users.ts",
      "src/server.ts",
    ]);
    expect(out.plan.impactedFiles).not.toContain("src/routes/health.ts");

    // No route-bearing file's own text changed, so every route is retained by reference.
    for (const prev of base.result.routes) {
      const now = out.result.routes.find(
        (r) => r.file === prev.file && r.path === prev.path && r.method === prev.method,
      );
      expect(now).toBe(prev);
    }
    // Schema unchanged by reference (no php/sql edit).
    expect(out.result.schema).toBe(base.result.schema);
  });

  it("removing a route file drops its routes and maps its still-present importer", () => {
    const { root } = makeFixture();
    const base = baseline(root);

    // Remove health.ts. server.ts still imports "./routes/health.js".
    rmSync(join(root, "src/routes/health.ts"), { force: true });

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });

    // The removed file's route is gone; the users routes survive by reference.
    expect(out.result.routes.some((r) => r.path === "/health")).toBe(false);
    expect(out.result.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /users",
      "POST /users",
    ]);
    const prevGetUsers = base.result.routes.find((r) => r.method === "GET" && r.path === "/users");
    expect(out.result.routes.find((r) => r.method === "GET" && r.path === "/users")).toBe(
      prevGetUsers,
    );

    // Schema untouched (no php/sql change) -> reused by reference.
    expect(out.result.schema).toBe(base.result.schema);

    // The removed file's dependent (server.ts, which still imports it) is flagged
    // via the augmented graph; the removed file itself is excluded.
    expect(out.plan.impactedFiles).toEqual(["src/server.ts"]);
    expect(out.plan.rerun).toEqual({ structure: true, routes: true, schema: false });
  });

  it("the incremental result equals a full re-extraction of the edited repo", () => {
    const { root, write } = makeFixture();
    const base = baseline(root);

    write(
      "src/routes/health.ts",
      [
        `export function healthRoutes(router) {`,
        `  router.get('/healthz', healthHandler);`,
        `}`,
        ``,
      ].join("\n"),
    );

    const out = incrementalUpdate(root, base.snapshot, base.result, { toolVersion: TOOL });
    const fresh = buildIndex(root);
    expect(out.result.routes).toEqual(extractRoutes(fresh));
    expect(out.result.schema).toEqual(extractSchema(fresh));
    expect(out.result.structure).toEqual(extractStructure(fresh));
  });
});
