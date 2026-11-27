/**
 * Knowstone — package.json scripts extractor.
 *
 * Projects a project Index into a flat, deterministic list of the npm scripts
 * declared across its package.json files (root and, for a monorepo, every nested
 * package that is not inside an ignored directory). Each entry is one script: the
 * package.json it lives in, the script name, and its command string.
 *
 * package.json files are plain JSON, not source files, so they are not part of
 * the import graph or `index.files`. They are found by a small self-contained,
 * read-only directory walk that mirrors the indexer's conventions (no symlinks,
 * no hidden or noise directories), the same way the schema extractor discovers
 * .sql files.
 *
 * Determinism: files are processed in sorted path order and, within a file, the
 * scripts are sorted by name. Only string-valued entries of the top-level
 * "scripts" object are kept; a malformed package.json (or one with no scripts) is
 * skipped. Best-effort: every fs and JSON.parse call is guarded, so it never
 * throws. See ../../../PLAN.md (M3).
 */

import fs from "node:fs";
import path from "node:path";
import type { Index } from "./indexer.js";

export interface ScriptEntry {
  /** Repo-relative path of the package.json, forward slashes (e.g. "package.json"). */
  file: string;
  /** The script name, e.g. "build". */
  name: string;
  /** The command the script runs. */
  command: string;
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

/**
 * Read-only walk of root for package.json files. Returns repo-relative,
 * forward-slash paths, sorted. Mirrors the indexer's conventions: never follows
 * symlinks, skips hidden directories (names starting with ".") and the shared
 * noise directories. Best-effort: all fs calls are wrapped so it never throws.
 */
export function findPackageJsonFiles(root: string): string[] {
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
      if (name !== "package.json") continue;
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

/** Parse the "scripts" object of one package.json file into entries. */
function parseScripts(content: string, file: string, out: ScriptEntry[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return; // malformed package.json: skip, best-effort
  }
  if (typeof parsed !== "object" || parsed === null) return;

  const scripts = (parsed as { scripts?: unknown }).scripts;
  // Must be a plain object: a string, array or null "scripts" value is not a
  // script map (an array would otherwise yield bogus "0"/"1" names).
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return;

  const entries: ScriptEntry[] = [];
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command === "string") entries.push({ file, name, command });
  }
  // Sort each file's scripts by name for a stable order independent of key order.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.push(...entries);
}

/**
 * Extract every npm script declared across the repo's package.json files. The
 * package.json files are found by a self-contained walk of index.root (they are
 * not part of index.files). Entries are grouped by file in sorted path order and,
 * within a file, sorted by script name. Unreadable or malformed files are skipped
 * (best-effort, never throws).
 */
export function extractScripts(index: Index): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  for (const file of findPackageJsonFiles(index.root)) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(index.root, file), "utf8");
    } catch {
      continue; // unreadable file: skip, best-effort
    }
    parseScripts(content, file, out);
  }
  return out;
}
