/**
 * Knowstone — import extraction, import graph and dependency cones.
 *
 * A Knowstone "fact" is derived from reading a source file F. If F changes the
 * fact is stale; if anything F imports (directly or transitively) changes the
 * fact is also potentially stale, because F's behaviour depends on it. The
 * dependency cone of F is therefore the forward import closure: { F } plus every
 * file F transitively imports. The closure must terminate even when imports form
 * a cycle. See ../../../PLAN.md.
 *
 * Correctness note: we would rather over-invalidate than miss a dependency. When
 * a file has an import we cannot resolve to a repo file (a path alias, an
 * absolute path, or a computed/dynamic import), we record that file in
 * `incomplete`. A binding whose cone touches an incomplete file is withheld for
 * re-verification rather than risk serving a fact whose real dependency changed
 * without us noticing.
 */

import fs from "node:fs";
import path from "node:path";

export type Language = "ts" | "js" | "php" | "py" | "go";

/** Extensions we recognise for ts/js resolution, in the order we try them. */
const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

/**
 * Decide language from file extension. Returns null for unknown types.
 * .ts/.tsx/.mts/.cts -> "ts"; .js/.jsx/.mjs/.cjs -> "js"; .php -> "php";
 * .py -> "py"; .go -> "go".
 */
export function detectLanguage(file: string): Language | null {
  const lower = file.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = lower.slice(dot);
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "ts";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".php":
      return "php";
    case ".py":
      return "py";
    case ".go":
      return "go";
    default:
      return null;
  }
}

/**
 * Extract raw import specifiers (the strings as written in source) from one
 * file's content, best-effort per language:
 *  - ts/js: `import ... from "x"`, `export ... from "x"`, `import("x")`,
 *    `require("x")`, and static template imports `import(`x`)` with no `${}`.
 *  - php: `use A\B\C;` namespace, and require/require_once/include/include_once "path"
 *  - py: `import a.b`, `from a.b import c`
 *  - go: single `import "x"` and grouped `import ( "x" \n "y" )`
 *  Return the specifiers verbatim (dedupe). Unknown language returns [].
 */
export function extractImports(language: Language, content: string): string[] {
  const out: string[] = [];
  const add = (spec: string | undefined): void => {
    if (spec && !out.includes(spec)) out.push(spec);
  };

  switch (language) {
    case "ts":
    case "js":
      extractTsJs(content, add);
      break;
    case "php":
      extractPhp(content, add);
      break;
    case "py":
      extractPy(content, add);
      break;
    case "go":
      extractGo(content, add);
      break;
  }

  return out;
}

function extractTsJs(content: string, add: (spec: string | undefined) => void): void {
  // `import ... from "x"` and `export ... from "x"` (also bare `import "x"`).
  const fromRe = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  // Bare `import "x"` (side-effect import, no `from`).
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
  // Dynamic `import("x")` and `require("x")` with a quoted literal.
  const callRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Static template `import(`x`)` with no interpolation (no backtick or `$` inside).
  const templateRe = /\b(?:import|require)\s*\(\s*`([^`$]+)`\s*\)/g;

  for (const re of [fromRe, bareImportRe, callRe, templateRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      add(m[1]);
    }
  }
}

function extractPhp(content: string, add: (spec: string | undefined) => void): void {
  // `use A\B\C;` namespace imports (optionally with `as Alias`).
  const useRe = /\buse\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    add(m[1]);
  }

  // require/require_once/include/include_once "path".
  const incRe = /\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/g;
  while ((m = incRe.exec(content)) !== null) {
    add(m[1]);
  }
}

function extractPy(content: string, add: (spec: string | undefined) => void): void {
  // `from a.b import c` — capture the module `a.b`.
  const fromRe = /^[ \t]*from\s+([.\w]+)\s+import\b/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(content)) !== null) {
    add(m[1]);
  }

  // `import a.b` / `import a.b as c` / `import a, b` — capture each module.
  const importRe = /^[ \t]*import\s+(.+)$/gm;
  while ((m = importRe.exec(content)) !== null) {
    const names = m[1];
    if (!names) continue;
    for (const part of names.split(",")) {
      // Drop any `as alias` suffix and surrounding whitespace.
      const mod = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      add(mod);
    }
  }
}

function extractGo(content: string, add: (spec: string | undefined) => void): void {
  // Grouped `import ( "x" \n "y" )` — pull each quoted string inside the block.
  const groupRe = /\bimport\s*\(([\s\S]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(content)) !== null) {
    const body = m[1] ?? "";
    const strRe = /(?:[A-Za-z_.][A-Za-z0-9_]*\s+)?"([^"]+)"/g;
    let s: RegExpExecArray | null;
    while ((s = strRe.exec(body)) !== null) {
      add(s[1]);
    }
  }

  // Single `import "x"` or `import alias "x"` (not followed by `(`).
  const singleRe = /\bimport\s+(?:[A-Za-z_.][A-Za-z0-9_]*\s+)?"([^"]+)"/g;
  while ((m = singleRe.exec(content)) !== null) {
    add(m[1]);
  }
}

export interface ImportGraph {
  /**
   * file (repo-relative, forward slashes) -> set of repo-relative files it
   * imports that EXIST in the provided file set. External/unresolved specifiers
   * are dropped from the edges.
   */
  edges: Map<string, Set<string>>;
  /**
   * Files whose imports could NOT be fully accounted for: a relative import that
   * did not resolve to a repo file, a path-alias import (`@/..`, `~/..`), an
   * absolute import, or a computed/dynamic import. A cone that touches any of
   * these is not safe to call complete.
   */
  incomplete: Set<string>;
}

/** Normalise any path to repo-relative forward slashes, with "./" and ".." collapsed. */
function normalisePath(p: string): string {
  const forward = p.split(path.sep).join("/").split("\\").join("/");
  const normalised = path.posix.normalize(forward);
  return normalised.startsWith("./") ? normalised.slice(2) : normalised;
}

/** True for specifiers that point inside the repo but which M1 cannot resolve. */
function isUnresolvableInRepo(spec: string): boolean {
  return spec.startsWith("@/") || spec.startsWith("~") || spec.startsWith("/");
}

/**
 * Detect a computed/dynamic import whose argument is not a static literal, e.g.
 * `import(variable)` or `import(`./${name}.js`)`. Such a file may depend on code
 * we cannot see, so its cone is not complete. ts/js only.
 */
function hasComputedImport(content: string): boolean {
  // `import(` / `require(` whose first non-space argument char is not a quote or backtick.
  const nonLiteral = /\b(?:import|require)\s*\(\s*(?!['"`])/;
  // A template literal argument that contains an interpolation.
  const interpolated = /\b(?:import|require)\s*\(\s*`[^`]*\$\{/;
  return nonLiteral.test(content) || interpolated.test(content);
}

/**
 * Build the import graph over the given repo-relative files. root is the
 * absolute repo root. Read each file, extract its imports, and resolve RELATIVE
 * specifiers (starting with ".") against the file's directory to a repo-relative
 * path, trying the known extensions and /index files for ts/js, with a
 * case-insensitive fallback (this repo runs on case-insensitive filesystems). A
 * resolved target is kept only if it is in the input file set. Specifiers we
 * cannot resolve to a repo file mark the importing file as incomplete. Forward
 * slashes everywhere.
 */
export function buildImportGraph(root: string, files: string[]): ImportGraph {
  const normalisedFiles = files.map(normalisePath);
  const fileSet = new Set(normalisedFiles);
  // Lowercase index for case-insensitive resolution; maps lower-case -> actual.
  const lowerIndex = new Map<string, string>();
  for (const f of fileSet) {
    lowerIndex.set(f.toLowerCase(), f);
  }

  const edges = new Map<string, Set<string>>();
  const incomplete = new Set<string>();

  for (const file of normalisedFiles) {
    const language = detectLanguage(file);
    const targets = new Set<string>();
    edges.set(file, targets);

    if (language === null) continue;

    const absPath = path.join(root, file);
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      // Unreadable file: we cannot account for its imports, so treat as incomplete.
      incomplete.add(file);
      continue;
    }

    const specifiers = extractImports(language, content);
    const fileDir = path.posix.dirname(file);

    for (const spec of specifiers) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(fileDir, spec, language, fileSet, lowerIndex);
        if (resolved !== null && resolved !== file) {
          targets.add(resolved);
        } else if (resolved === null) {
          // A relative import we could not locate in the repo: do not miss it.
          incomplete.add(file);
        }
      } else if (isUnresolvableInRepo(spec)) {
        incomplete.add(file);
      }
      // Otherwise a bare external module (npm package, node builtin, php
      // namespace, python package, go import path): outside the repo, ignored.
    }

    if ((language === "ts" || language === "js") && hasComputedImport(content)) {
      incomplete.add(file);
    }
  }

  return { edges, incomplete };
}

/**
 * Resolve a relative specifier against the importing file's directory (both
 * repo-relative, posix). Returns a repo-relative target that exists in fileSet,
 * or null. For ts/js we try the specifier as-is, then each known extension, then
 * as a directory with /index.<ext>; we also strip a trailing ".js" and retry as
 * a ts/js source (NodeNext writes ./x.js meaning ./x.ts). Lookups fall back to a
 * case-insensitive match so a `./B.js` import finds `b.ts` on a case-insensitive
 * filesystem. For other languages we only try the specifier as written.
 */
function resolveRelative(
  fileDir: string,
  spec: string,
  language: Language,
  fileSet: Set<string>,
  lowerIndex: Map<string, string>,
): string | null {
  const base = normalisePath(path.posix.join(fileDir, spec));

  const exists = (candidate: string): string | null => {
    const normalised = normalisePath(candidate);
    if (fileSet.has(normalised)) return normalised;
    const ci = lowerIndex.get(normalised.toLowerCase());
    return ci ?? null;
  };

  // Exact match as written (works for php/py/go relative paths too).
  const asIs = exists(base);
  if (asIs !== null) return asIs;

  if (language !== "ts" && language !== "js") {
    return null;
  }

  // The stems to try: the specifier itself, plus a ".js" -> "" rewrite so a
  // NodeNext "./x.js" can match an on-disk "./x.ts".
  const stems = new Set<string>([base]);
  if (base.toLowerCase().endsWith(".js")) {
    stems.add(base.slice(0, -3));
  }

  for (const stem of stems) {
    for (const ext of TS_JS_EXTENSIONS) {
      const hit = exists(stem + ext);
      if (hit !== null) return hit;
    }
  }

  // Directory with an /index.<ext> file.
  for (const ext of TS_JS_EXTENSIONS) {
    const hit = exists(normalisePath(path.posix.join(base, "index" + ext)));
    if (hit !== null) return hit;
  }

  return null;
}

/**
 * Forward transitive closure: target plus everything it (transitively) imports,
 * per the graph. MUST terminate on cycles. Returns a Set including target itself
 * (even if target has no edges). If target is not in the graph, return a set
 * containing just target.
 */
export function dependencyCone(graph: ImportGraph, target: string): Set<string> {
  const normalised = normalisePath(target);
  const visited = new Set<string>();
  const stack: string[] = [normalised];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    const next = graph.edges.get(current);
    if (next === undefined) continue;
    for (const dep of next) {
      if (!visited.has(dep)) stack.push(dep);
    }
  }

  return visited;
}
