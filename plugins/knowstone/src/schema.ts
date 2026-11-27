/**
 * Knowstone — DB-schema extractor.
 *
 * Projects a project Index into a flat, deterministic list of database tables
 * and their columns, best-effort from two sources:
 *  - Laravel migrations (.php): `Schema::create('table', function (Blueprint
 *    $table) { ... })` blocks, whose body is scanned statement-by-statement
 *    (split on `;`). The FIRST `$table-><method>(...)` on a statement names a
 *    column: the method is the column TYPE and its first string argument is the
 *    column NAME. Trailing chained modifiers (`->nullable()`, `->default(...)`,
 *    ...) and standalone constraint calls (`$table->foreign(...)->on(...)`) are
 *    therefore ignored. A few methods expand or rename specially (id,
 *    timestamps, softDeletes, rememberToken); a constraint method as the first
 *    call (foreign/primary/unique/index/...) emits no column.
 *  - Plain SQL (.sql): `CREATE TABLE [IF NOT EXISTS] name ( ... )`. The body is
 *    split on top-level commas; a leading constraint keyword (CONSTRAINT,
 *    PRIMARY, FOREIGN, UNIQUE, KEY, INDEX, CHECK) skips the item, otherwise the
 *    first token is the column name and the next token (with any parenthesised
 *    size) is the type.
 *
 * Because .sql files carry no import graph they are deliberately excluded from
 * `index.files`, so SQL sources are found by a small self-contained, read-only
 * directory walk that mirrors the indexer's conventions (no symlinks, no hidden
 * or noise dirs). The Laravel .php sources come from `index.files`.
 *
 * Determinism: .php files (from the sorted index) are processed first, then the
 * discovered .sql files in sorted path order, accumulating into a map keyed by
 * table name. The FIRST definition of a given table name wins its whole column
 * set; later redefinitions of an already-seen table are ignored. Columns keep
 * source order and are deduped by name (first occurrence wins). The result is
 * sorted by table name ascending.
 *
 * Known limitations: parsing is regex/scanner-based, not a real PHP/SQL parser.
 * Commented-out definitions are still matched (comments are not stripped).
 * Column/constraint keywords or table names that appear inside a string literal
 * containing an unbalanced quote or paren can confuse the brace/paren matcher. A
 * schema-qualified SQL name (`public.users`) keeps only its final part
 * (`users`), and a quoted SQL table name containing a space is not parsed. SQL
 * type capture keeps the type token plus its immediate parenthesised size
 * (`VARCHAR(255)`, `DECIMAL(8, 2)`) as written; anything after it (e.g.
 * `UNSIGNED`, `NOT NULL`) is dropped. A MySQL inline named index
 * (`KEY idx_name (col)`) is indistinguishable from a column here and is read as
 * one. Only `Schema::create` is parsed: columns added by a later `Schema::table`
 * (ALTER) migration are not reflected, and a Laravel FK helper given no string
 * name (`foreignIdFor(User::class)`) contributes no column.
 */

import fs from "node:fs";
import path from "node:path";
import { detectLanguage } from "./imports.js";
import type { Index } from "./indexer.js";

export interface Column {
  /** Column name. */
  name: string;
  /** Best-effort type string; "" if genuinely unknown. */
  type: string;
}

export interface Table {
  /** Table name. */
  table: string;
  /** Columns in source order, deduped by name (first wins). */
  columns: Column[];
}

/** Directory names that are noise in almost every project and are always skipped. */
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  "venv",
  "bin",
  "obj",
]);

/** Laravel `$table->` methods that introduce no column and must be skipped. */
const LARAVEL_SKIP = new Set([
  "foreign",
  "primary",
  "unique",
  "index",
  "dropColumn",
  "spatialIndex",
  "fullText",
  "rawIndex",
]);

/** SQL leading tokens that ALWAYS begin a table constraint (never a column name). */
const SQL_ALWAYS_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "FOREIGN"]);
/**
 * SQL leading tokens that begin a constraint only in constraint shape; the same
 * words are also valid unquoted column names in some engines (Postgres `key`,
 * `value`, `index`), so their shape is checked before skipping.
 */
const SQL_AMBIGUOUS_CONSTRAINT = new Set(["UNIQUE", "KEY", "INDEX", "CHECK"]);

/** Strip surrounding backticks, double/single quotes or square brackets from a name. */
function stripQuotes(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (
      (first === "`" && last === "`") ||
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "[" && last === "]")
    ) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Append a column to a list, deduping by name (first occurrence wins). */
function pushColumn(columns: Column[], seen: Set<string>, name: string, type: string): void {
  if (name === "" || seen.has(name)) return;
  seen.add(name);
  columns.push({ name, type });
}

/**
 * Starting at the index of an opening delimiter in content, return the index of
 * its matching close (depth-aware), or -1 if unbalanced. open/close are single
 * characters, e.g. "{"/"}" or "("/")".
 */
function matchDelimiter(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract the first single/double quoted string's contents from text, or null. */
function firstStringArg(text: string): string | null {
  const m = /['"]([^'"]*)['"]/.exec(text);
  return m ? (m[1] ?? "") : null;
}

/** Parse the body of one Schema::create closure into columns. */
function parseLaravelBody(body: string, columns: Column[], seen: Set<string>): void {
  for (const statement of body.split(";")) {
    const call = /\$table->([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(statement);
    if (call === null) continue;
    const method = call[1] ?? "";
    const rest = statement.slice(call.index + call[0].length);

    switch (method) {
      case "id":
        // `$table->id()` defaults the column to "id"; `$table->id('custom')` names it.
        pushColumn(columns, seen, firstStringArg(rest) ?? "id", "id");
        continue;
      case "timestamps":
      case "timestampsTz":
        pushColumn(columns, seen, "created_at", "timestamp");
        pushColumn(columns, seen, "updated_at", "timestamp");
        continue;
      case "softDeletes":
      case "softDeletesTz":
        pushColumn(columns, seen, "deleted_at", "timestamp");
        continue;
      case "rememberToken":
        pushColumn(columns, seen, "remember_token", "string");
        continue;
    }

    if (LARAVEL_SKIP.has(method)) continue;

    const name = firstStringArg(rest);
    if (name === null) continue; // a non-special method with no string arg: cannot name a column
    pushColumn(columns, seen, name, method);
  }
}

/** Find every Schema::create block in a PHP file and record its table + columns. */
function parseLaravel(content: string, record: (table: string, columns: Column[]) => void): void {
  // Match through the opening `{` of the closure body; params hold no braces.
  // An optional `static` before `function` is allowed (a common house style).
  const re = /Schema::create\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(?:static\s+)?function\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const table = stripQuotes(m[2] ?? "");
    const braceOpen = m.index + m[0].length - 1; // index of the `{`
    const braceClose = matchDelimiter(content, braceOpen, "{", "}");
    if (braceClose === -1) continue; // unbalanced: skip, best-effort
    const body = content.slice(braceOpen + 1, braceClose);
    const columns: Column[] = [];
    const seen = new Set<string>();
    parseLaravelBody(body, columns, seen);
    record(table, columns);
    re.lastIndex = braceClose; // continue scanning after this block
  }
}

/** Split a CREATE TABLE body on commas that sit at the top parenthesis level. */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") items.push(current);
  return items;
}

/**
 * Decide whether a CREATE TABLE item is a table constraint rather than a column.
 * CONSTRAINT/PRIMARY/FOREIGN always start a constraint. UNIQUE/KEY/INDEX/CHECK
 * start a constraint only in constraint shape: directly followed by "(" (e.g.
 * `KEY (a)`, `UNIQUE (code)`, `CHECK (x > 0)`) or by KEY/INDEX (`UNIQUE KEY ...`,
 * `UNIQUE INDEX ...`). Followed by a type word they are instead a column literally
 * named with that keyword (Postgres `key text`, `value text`, `index int`). The
 * residual MySQL named inline index `KEY idx_name (col)` cannot be told from a
 * column here and is treated as one.
 */
function isSqlConstraintItem(trimmed: string, firstToken: string): boolean {
  const upper = firstToken.toUpperCase();
  if (SQL_ALWAYS_CONSTRAINT.has(upper)) return true;
  if (SQL_AMBIGUOUS_CONSTRAINT.has(upper)) {
    const after = trimmed.slice(firstToken.length).trimStart();
    if (after.startsWith("(")) return true;
    const second = (after.split(/\s+/)[0] ?? "").toUpperCase();
    return second === "KEY" || second === "INDEX";
  }
  return false;
}

/** Parse one CREATE TABLE column item into a column, or null for a constraint item. */
function parseSqlColumn(item: string): Column | null {
  const trimmed = item.trim();
  if (trimmed === "") return null;

  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (isSqlConstraintItem(trimmed, firstToken)) return null;

  const name = stripQuotes(firstToken);
  if (name === "") return null;

  const afterName = trimmed.slice(firstToken.length).trim();
  // Type token: a word, optionally followed by its parenthesised size.
  const typeMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?/.exec(afterName);
  const type = typeMatch ? (typeMatch[1] ?? "") + (typeMatch[2] ?? "") : "";
  return { name, type };
}

/** Find every CREATE TABLE in a SQL file and record its table + columns. */
function parseSql(content: string, record: (table: string, columns: Column[]) => void): void {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const rawName = stripQuotes(m[1] ?? "");
    const parts = rawName.split(".");
    const table = parts[parts.length - 1] ?? rawName; // schema-qualified: keep final part
    const parenOpen = m.index + m[0].length - 1; // index of the `(`
    const parenClose = matchDelimiter(content, parenOpen, "(", ")");
    if (parenClose === -1) continue; // unbalanced: skip, best-effort
    const body = content.slice(parenOpen + 1, parenClose);
    const columns: Column[] = [];
    const seen = new Set<string>();
    for (const item of splitTopLevel(body)) {
      const column = parseSqlColumn(item);
      if (column !== null) pushColumn(columns, seen, column.name, column.type);
    }
    record(table, columns);
    re.lastIndex = parenClose;
  }
}

/**
 * Read-only walk of root for .sql files only. Returns repo-relative,
 * forward-slash paths, sorted. Mirrors the indexer's listSourceFiles
 * conventions: never follows symlinks, skips hidden directories (names starting
 * with ".") and the shared noise directories. Best-effort: all fs calls are
 * wrapped so it never throws.
 */
export function findSqlFiles(root: string): string[] {
  const out: string[] = [];

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, best-effort
    }

    for (const entry of entries) {
      const name = entry.name;
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      const relPath = relDir === "" ? name : `${relDir}/${name}`;

      if (entry.isDirectory()) {
        if (name.startsWith(".") || IGNORE_DIRS.has(name)) continue;
        walk(path.join(absDir, name), relPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!name.toLowerCase().endsWith(".sql")) continue;
      out.push(relPath);
    }
  };

  try {
    walk(root, "");
  } catch {
    // Any unexpected failure: return what we have, never throw.
  }
  return out.sort();
}

/**
 * Extract the database schema across the index's Laravel migrations (.php files
 * in the index) and plain SQL files (found by a self-contained walk of
 * index.root). Returns tables sorted by name; see the module JSDoc for the
 * duplicate-table and column-dedupe rules. Unreadable files are skipped
 * (best-effort, never throws).
 */
export function extractSchema(index: Index): Table[] {
  const tables = new Map<string, Column[]>();
  const record = (table: string, columns: Column[]): void => {
    if (table === "" || tables.has(table)) return; // first definition of a table wins
    tables.set(table, columns);
  };

  // Laravel migrations: the .php files already in the (sorted) index.
  for (const file of index.files) {
    if (detectLanguage(file) !== "php") continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(index.root, file), "utf8");
    } catch {
      continue; // unreadable file: skip, best-effort
    }
    parseLaravel(content, record);
  }

  // Plain SQL: not in index.files, so walk for them ourselves (sorted order).
  for (const file of findSqlFiles(index.root)) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(index.root, file), "utf8");
    } catch {
      continue; // unreadable file: skip, best-effort
    }
    parseSql(content, record);
  }

  return [...tables.entries()]
    .map(([table, columns]) => ({ table, columns }))
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}
