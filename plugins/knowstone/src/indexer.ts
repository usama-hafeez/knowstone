/**
 * Knowstone — project indexer core.
 *
 * Walks a repository to find its source files, then builds the import graph over
 * them. This is the base layer the structure/route/schema extractors build on.
 * It is read-only and never follows symlinks (loop and escape safety).
 */

import fs from "node:fs";
import path from "node:path";
import { buildImportGraph, detectLanguage, type ImportGraph } from "./imports.js";

/** Directory names that are noise in almost every project and are always skipped. */
const DEFAULT_IGNORE_DIRS = new Set([
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

export interface ListOptions {
  /** Extra directory names to skip, in addition to the defaults. */
  ignoreDirs?: string[];
  /** Maximum file size in bytes to include (default 2 MiB). Larger files are skipped. */
  maxFileBytes?: number;
}

/**
 * Walk the repo and return repo-relative, forward-slash source file paths
 * (ts/js/php/py/go), sorted. Hidden directories (names starting with ".") and
 * the default noise directories are skipped, symlinks are not followed, and
 * files larger than maxFileBytes are omitted. Note: .gitignore is not honoured
 * yet (a known limitation).
 */
export function listSourceFiles(root: string, options: ListOptions = {}): string[] {
  const ignore = new Set(DEFAULT_IGNORE_DIRS);
  for (const dir of options.ignoreDirs ?? []) ignore.add(dir);
  const maxBytes = options.maxFileBytes ?? 2 * 1024 * 1024;

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
        if (name.startsWith(".") || ignore.has(name)) continue;
        walk(path.join(absDir, name), relPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (detectLanguage(name) === null) continue;
      try {
        if (fs.statSync(path.join(absDir, name)).size > maxBytes) continue;
      } catch {
        continue;
      }
      out.push(relPath);
    }
  };

  walk(root, "");
  return out.sort();
}

export interface Index {
  /** Absolute repo root. */
  root: string;
  /** Repo-relative source file paths. */
  files: string[];
  /** Import graph over those files. */
  graph: ImportGraph;
}

/** Build a project index: the source file list plus its import graph. */
export function buildIndex(root: string, options: ListOptions = {}): Index {
  const files = listSourceFiles(root, options);
  const graph = buildImportGraph(root, files);
  return { root, files, graph };
}
