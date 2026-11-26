import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractSchema } from "../src/schema.js";

const temps: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-schema-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };

  write(
    "database/migrations/2024_create_users.php",
    [
      "<?php",
      "Schema::create('users', function (Blueprint $table) {",
      "    $table->id();",
      "    $table->string('name');",
      "    $table->string('email')->nullable()->unique();",
      "    $table->integer('age')->default(0);",
      "    $table->boolean('active');",
      "    $table->foreignId('team_id');",
      "    $table->foreign('team_id')->references('id')->on('teams');",
      "    $table->timestamps();",
      "});",
      "",
    ].join("\n"),
  );

  write(
    "db/schema.sql",
    [
      "CREATE TABLE IF NOT EXISTS public.orders (",
      "  id INT PRIMARY KEY,",
      "  customer VARCHAR(255) NOT NULL,",
      "  amount DECIMAL(8, 2),",
      "  code VARCHAR(32),",
      "  PRIMARY KEY (id),",
      "  UNIQUE (code),",
      "  CONSTRAINT fk_cust FOREIGN KEY (customer) REFERENCES customers(id)",
      ");",
      "",
    ].join("\n"),
  );

  // A Postgres settings table whose columns are named like constraint keywords,
  // alongside a real standalone UNIQUE constraint.
  write(
    "db/settings.sql",
    [
      "CREATE TABLE settings (",
      "  key text,",
      "  value text,",
      "  index int,",
      "  UNIQUE (key)",
      ");",
      "",
    ].join("\n"),
  );

  // A migration using a `static function` closure and a custom-named id column.
  write(
    "database/migrations/2024_create_widgets.php",
    [
      "<?php",
      "Schema::create('widgets', static function (Blueprint $table) {",
      "    $table->id('widget_id');",
      "    $table->string('label');",
      "});",
      "",
    ].join("\n"),
  );

  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractSchema", () => {
  it("parses a Laravel migration with specials and ignores chained modifiers", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const users = tables.find((t) => t.table === "users");
    expect(users).toBeDefined();
    expect(users?.columns).toEqual([
      { name: "id", type: "id" },
      { name: "name", type: "string" },
      { name: "email", type: "string" },
      { name: "age", type: "integer" },
      { name: "active", type: "boolean" },
      { name: "team_id", type: "foreignId" },
      { name: "created_at", type: "timestamp" },
      { name: "updated_at", type: "timestamp" },
    ]);
  });

  it("expands timestamps() to created_at + updated_at and does not duplicate columns", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const users = tables.find((t) => t.table === "users");
    const names = users?.columns.map((c) => c.name) ?? [];
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
    // ->nullable()/->default()/->unique() modifiers add no extra columns.
    expect(names.filter((n) => n === "email")).toHaveLength(1);
    expect(names.filter((n) => n === "age")).toHaveLength(1);
  });

  it("treats a standalone $table->foreign(...) constraint as no column", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const users = tables.find((t) => t.table === "users");
    // team_id appears once (from foreignId), never a second time from the foreign() line.
    const teamIds = users?.columns.filter((c) => c.name === "team_id") ?? [];
    expect(teamIds).toEqual([{ name: "team_id", type: "foreignId" }]);
  });

  it("parses a plain SQL CREATE TABLE, skips constraints and does not mis-split DECIMAL", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const orders = tables.find((t) => t.table === "orders");
    expect(orders).toBeDefined();
    expect(orders?.columns).toEqual([
      { name: "id", type: "INT" },
      { name: "customer", type: "VARCHAR(255)" },
      { name: "amount", type: "DECIMAL(8, 2)" },
      { name: "code", type: "VARCHAR(32)" },
    ]);
    // PRIMARY KEY / UNIQUE / CONSTRAINT lines produced no columns.
    const names = orders?.columns.map((c) => c.name) ?? [];
    expect(names).not.toContain("PRIMARY");
    expect(names).not.toContain("CONSTRAINT");
  });

  it("finds a .sql file even though it is not in index.files", () => {
    const index = buildIndex(makeRepo());
    // The indexer excludes .sql files: prove the self-walk reaches it anyway.
    expect(index.files.some((f) => f.endsWith(".sql"))).toBe(false);
    const tables = extractSchema(index);
    expect(tables.some((t) => t.table === "orders")).toBe(true);
  });

  it("returns tables sorted by name ascending", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const names = tables.map((t) => t.table);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(["orders", "settings", "users", "widgets"]);
  });

  it("keeps SQL columns named like a constraint keyword (key/value/index)", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const settings = tables.find((t) => t.table === "settings");
    expect(settings).toBeDefined();
    // The standalone `UNIQUE (key)` is a constraint and adds no column;
    // the `key`/`value`/`index` columns are kept.
    expect(settings?.columns).toEqual([
      { name: "key", type: "text" },
      { name: "value", type: "text" },
      { name: "index", type: "int" },
    ]);
  });

  it("parses a `static function` migration closure", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const widgets = tables.find((t) => t.table === "widgets");
    expect(widgets).toBeDefined();
    const names = widgets?.columns.map((c) => c.name) ?? [];
    expect(names).toContain("label");
  });

  it("honours a custom-named id column `$table->id('widget_id')`", () => {
    const tables = extractSchema(buildIndex(makeRepo()));
    const widgets = tables.find((t) => t.table === "widgets");
    expect(widgets?.columns).toContainEqual({ name: "widget_id", type: "id" });
    expect(widgets?.columns.some((c) => c.name === "id")).toBe(false);
  });
});
