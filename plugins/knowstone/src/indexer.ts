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

/**
 * Default ceiling on how many source files one index will hold. A pathological or
 * very large monorepo must stay cheap and bounded rather than walk unboundedly, so
 * the walk stops once this many files are collected. Generous enough that ordinary
 * repositories are never affected; configurable via ListOptions.maxFiles.
 */
export const DEFAULT_MAX_FILES = 50_000;

export interface ListOptions {
  /** Extra directory names to skip, in addition to the defaults. */
  ignoreDirs?: string[];
  /** Maximum file size in bytes to include (default 2 MiB). Larger files are skipped. */
  maxFileBytes?: number;
  /** Maximum number of files to collect (default DEFAULT_MAX_FILES). Keeps huge repos cheap. */
  maxFiles?: number;
}

/** A source-file walk result: the files plus whether the file cap was reached. */
export interface WalkResult {
  /** Repo-relative, forward-slash source file paths, sorted. */
  files: string[];
  /**
   * True when the file cap was hit and the walk stopped early. `files` is always
   * returned sorted, but under truncation it is a traversal-order-dependent subset
   * of the repo, not a stable prefix, so callers must treat the resulting views as
   * incomplete rather than authoritative.
   */
  truncated: boolean;
}

/**
 * Walk the repo and return repo-relative, forward-slash source file paths
 * (ts/js/php/py/go), sorted, together with whether the file cap was reached.
 * Hidden directories (names starting with ".") and the default noise directories
 * are skipped, symlinks are not followed, files larger than maxFileBytes are
 * omitted, and collection stops once maxFiles files have been gathered. Note:
 * .gitignore is not honoured yet (a known limitation).
 */
export function walkSourceFiles(root: string, options: ListOptions = {}): WalkResult {
  const ignore = new Set(DEFAULT_IGNORE_DIRS);
  for (const dir of options.ignoreDirs ?? []) ignore.add(dir);
  const maxBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const out: string[] = [];
  let truncated = false;

  const walk = (absDir: string, relDir: string): void => {
    if (out.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, best-effort
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
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
  return { files: out.sort(), truncated };
}

/**
 * Walk the repo and return just the sorted source file list (ts/js/php/py/go).
 * Thin wrapper over walkSourceFiles for callers that do not need the truncation
 * flag; see walkSourceFiles for the full contract.
 */
export function listSourceFiles(root: string, options: ListOptions = {}): string[] {
  return walkSourceFiles(root, options).files;
}

export interface Index {
  /** Absolute repo root. */
  root: string;
  /** Repo-relative source file paths. */
  files: string[];
  /** Import graph over those files. */
  graph: ImportGraph;
  /**
   * True when the file cap was reached and the index is only a prefix of the repo.
   * Optional so existing hand-built Index literals stay valid; absent means false.
   */
  truncated?: boolean;
}

/** Build a project index: the source file list plus its import graph. */
export function buildIndex(root: string, options: ListOptions = {}): Index {
  const { files, truncated } = walkSourceFiles(root, options);
  const graph = buildImportGraph(root, files);
  return { root, files, graph, truncated };
}
