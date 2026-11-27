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
/** Extensions we recognise for ts/js resolution, in the order we try them. */
const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
/**
 * Decide language from file extension. Returns null for unknown types.
 * .ts/.tsx/.mts/.cts -> "ts"; .js/.jsx/.mjs/.cjs -> "js"; .php -> "php";
 * .py -> "py"; .go -> "go".
 */
export function detectLanguage(file) {
    const lower = file.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot === -1)
        return null;
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
export function extractImports(language, content) {
    const out = [];
    const add = (spec) => {
        if (spec && !out.includes(spec))
            out.push(spec);
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
function extractTsJs(content, add) {
    // `import ... from "x"` and `export ... from "x"` (also bare `import "x"`).
    const fromRe = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
    // Bare `import "x"` (side-effect import, no `from`).
    const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
    // Dynamic `import("x")` and `require("x")` with a quoted literal.
    const callRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    // Static template `import(`x`)` with no interpolation (no backtick or `$` inside).
    const templateRe = /\b(?:import|require)\s*\(\s*`([^`$]+)`\s*\)/g;
    for (const re of [fromRe, bareImportRe, callRe, templateRe]) {
        let m;
        while ((m = re.exec(content)) !== null) {
            add(m[1]);
        }
    }
}
function extractPhp(content, add) {
    // `use A\B\C;` namespace imports (optionally with `as Alias`).
    const useRe = /\buse\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*;/g;
    let m;
    while ((m = useRe.exec(content)) !== null) {
        add(m[1]);
    }
    // require/require_once/include/include_once "path".
    const incRe = /\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/g;
    while ((m = incRe.exec(content)) !== null) {
        add(m[1]);
    }
}
function extractPy(content, add) {
    // `from a.b import c` — capture the module `a.b`.
    const fromRe = /^[ \t]*from\s+([.\w]+)\s+import\b/gm;
    let m;
    while ((m = fromRe.exec(content)) !== null) {
        add(m[1]);
    }
    // `import a.b` / `import a.b as c` / `import a, b` — capture each module.
    const importRe = /^[ \t]*import\s+(.+)$/gm;
    while ((m = importRe.exec(content)) !== null) {
        const names = m[1];
        if (!names)
            continue;
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
function extractGo(content, add) {
    // Grouped `import ( "x" \n "y" )` — pull each quoted string inside the block.
    const groupRe = /\bimport\s*\(([\s\S]*?)\)/g;
    let m;
    while ((m = groupRe.exec(content)) !== null) {
        const body = m[1] ?? "";
        const strRe = /(?:[A-Za-z_.][A-Za-z0-9_]*\s+)?"([^"]+)"/g;
        let s;
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
/** Normalise any path to repo-relative forward slashes, with "./" and ".." collapsed. */
function normalisePath(p) {
    const forward = p.split(path.sep).join("/").split("\\").join("/");
    const normalised = path.posix.normalize(forward);
    return normalised.startsWith("./") ? normalised.slice(2) : normalised;
}
/** True for specifiers that point inside the repo but which M1 cannot resolve. */
function isUnresolvableInRepo(spec) {
    return spec.startsWith("@/") || spec.startsWith("~") || spec.startsWith("/");
}
/**
 * Detect a computed/dynamic import whose argument is not a static literal, e.g.
 * `import(variable)` or `import(`./${name}.js`)`. Such a file may depend on code
 * we cannot see, so its cone is not complete. ts/js only.
 */
function hasComputedImport(content) {
    // `import(` / `require(` whose first non-space argument char is not a quote or backtick.
    const nonLiteral = /\b(?:import|require)\s*\(\s*(?!['"`])/;
    // A template literal argument that contains an interpolation.
    const interpolated = /\b(?:import|require)\s*\(\s*`[^`]*\$\{/;
    return nonLiteral.test(content) || interpolated.test(content);
}
/** Strip // and block comments and trailing commas so a tsconfig parses as JSON. */
function parseJsonc(text) {
    const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const noLine = noBlock.replace(/(^|[^:"])\/\/.*$/gm, "$1");
    const noTrailingCommas = noLine.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(noTrailingCommas);
}
/**
 * Load path aliases from the repo's tsconfig.json (compilerOptions.baseUrl and
 * paths). Returns null when there is no tsconfig, it cannot be parsed, or it
 * declares no paths. `extends` is not followed yet (a known limitation).
 */
export function loadAliasConfig(root) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = parseJsonc(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const compilerOptions = parsed.compilerOptions;
    if (typeof compilerOptions !== "object" || compilerOptions === null)
        return null;
    const co = compilerOptions;
    if (typeof co.paths !== "object" || co.paths === null)
        return null;
    const paths = {};
    for (const [pattern, targets] of Object.entries(co.paths)) {
        if (Array.isArray(targets)) {
            const stringTargets = targets.filter((t) => typeof t === "string");
            if (stringTargets.length > 0)
                paths[pattern] = stringTargets;
        }
    }
    if (Object.keys(paths).length === 0)
        return null;
    const baseUrl = typeof co.baseUrl === "string" ? co.baseUrl : ".";
    return { baseUrl, paths };
}
/**
 * Resolve a non-relative specifier through tsconfig path aliases. Returns a
 * repo-relative file in the set, or null if no alias pattern matches or the
 * target does not exist.
 */
function resolveAlias(spec, aliases, fileSet, lowerIndex) {
    const baseDir = normalisePath(path.posix.join(aliases.baseUrl));
    for (const [pattern, targets] of Object.entries(aliases.paths)) {
        const star = pattern.indexOf("*");
        for (const target of targets) {
            let candidate = null;
            if (star === -1) {
                if (spec === pattern)
                    candidate = path.posix.join(baseDir, target);
            }
            else {
                const prefix = pattern.slice(0, star);
                const suffix = pattern.slice(star + 1);
                if (spec.length >= prefix.length + suffix.length &&
                    spec.startsWith(prefix) &&
                    spec.endsWith(suffix)) {
                    const middle = spec.slice(prefix.length, spec.length - suffix.length);
                    candidate = path.posix.join(baseDir, target.replace("*", middle));
                }
            }
            if (candidate !== null) {
                const hit = resolveCandidate(candidate, fileSet, lowerIndex, true);
                if (hit !== null)
                    return hit;
            }
        }
    }
    return null;
}
/**
 * Build the import graph over the given repo-relative files. root is the
 * absolute repo root. Read each file, extract its imports, and resolve RELATIVE
 * specifiers (starting with ".") against the file's directory, plus non-relative
 * specifiers through tsconfig path aliases when configured. A resolved target is
 * kept only if it is in the input file set. Specifiers we cannot resolve to a
 * repo file mark the importing file as incomplete. Forward slashes everywhere.
 */
export function buildImportGraph(root, files, options) {
    const normalisedFiles = files.map(normalisePath);
    const fileSet = new Set(normalisedFiles);
    // Lowercase index for case-insensitive resolution; maps lower-case -> actual.
    const lowerIndex = new Map();
    for (const f of fileSet) {
        lowerIndex.set(f.toLowerCase(), f);
    }
    // Explicit aliases (including null to disable) win; otherwise auto-load tsconfig.
    const aliases = options && "aliases" in options ? (options.aliases ?? null) : loadAliasConfig(root);
    const edges = new Map();
    const incomplete = new Set();
    for (const file of normalisedFiles) {
        const language = detectLanguage(file);
        const targets = new Set();
        edges.set(file, targets);
        if (language === null)
            continue;
        const absPath = path.join(root, file);
        let content;
        try {
            content = fs.readFileSync(absPath, "utf8");
        }
        catch {
            // Unreadable file: we cannot account for its imports, so treat as incomplete.
            incomplete.add(file);
            continue;
        }
        const specifiers = extractImports(language, content);
        const fileDir = path.posix.dirname(file);
        const tsLike = language === "ts" || language === "js";
        for (const spec of specifiers) {
            if (spec.startsWith(".")) {
                const resolved = resolveRelative(fileDir, spec, language, fileSet, lowerIndex);
                if (resolved !== null && resolved !== file) {
                    targets.add(resolved);
                }
                else if (resolved === null) {
                    // A relative import we could not locate in the repo: do not miss it.
                    incomplete.add(file);
                }
                continue;
            }
            // Non-relative: try tsconfig path aliases before giving up.
            const aliased = aliases !== null && tsLike ? resolveAlias(spec, aliases, fileSet, lowerIndex) : null;
            if (aliased !== null && aliased !== file) {
                targets.add(aliased);
            }
            else if (isUnresolvableInRepo(spec)) {
                // An alias-shaped or absolute intra-repo import we could not resolve.
                incomplete.add(file);
            }
            // Otherwise a bare external module (npm package, node builtin, php
            // namespace, python package, go import path): outside the repo, ignored.
        }
        if (tsLike && hasComputedImport(content)) {
            incomplete.add(file);
        }
    }
    return { edges, incomplete };
}
/**
 * Try to resolve a candidate repo-relative path to an actual file in the set,
 * falling back to a case-insensitive match. When tryExtensions is true (ts/js),
 * it also tries each known extension, a ".js" -> source rewrite (NodeNext writes
 * ./x.js meaning ./x.ts), and a directory /index.<ext> file.
 */
function resolveCandidate(candidate, fileSet, lowerIndex, tryExtensions) {
    const base = normalisePath(candidate);
    const exists = (c) => {
        const normalised = normalisePath(c);
        if (fileSet.has(normalised))
            return normalised;
        const ci = lowerIndex.get(normalised.toLowerCase());
        return ci ?? null;
    };
    const asIs = exists(base);
    if (asIs !== null)
        return asIs;
    if (!tryExtensions)
        return null;
    const stems = new Set([base]);
    if (base.toLowerCase().endsWith(".js")) {
        stems.add(base.slice(0, -3));
    }
    for (const stem of stems) {
        for (const ext of TS_JS_EXTENSIONS) {
            const hit = exists(stem + ext);
            if (hit !== null)
                return hit;
        }
    }
    for (const ext of TS_JS_EXTENSIONS) {
        const hit = exists(normalisePath(path.posix.join(base, "index" + ext)));
        if (hit !== null)
            return hit;
    }
    return null;
}
/**
 * Resolve a relative specifier against the importing file's directory. ts/js get
 * extension and /index trials; other languages are matched as written. Lookups
 * fall back to a case-insensitive match so a `./B.js` import finds `b.ts` on a
 * case-insensitive filesystem.
 */
function resolveRelative(fileDir, spec, language, fileSet, lowerIndex) {
    const base = path.posix.join(fileDir, spec);
    const tryExtensions = language === "ts" || language === "js";
    return resolveCandidate(base, fileSet, lowerIndex, tryExtensions);
}
/**
 * Forward transitive closure: target plus everything it (transitively) imports,
 * per the graph. MUST terminate on cycles. Returns a Set including target itself
 * (even if target has no edges). If target is not in the graph, return a set
 * containing just target.
 */
export function dependencyCone(graph, target) {
    const normalised = normalisePath(target);
    const visited = new Set();
    const stack = [normalised];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || visited.has(current))
            continue;
        visited.add(current);
        const next = graph.edges.get(current);
        if (next === undefined)
            continue;
        for (const dep of next) {
            if (!visited.has(dep))
                stack.push(dep);
        }
    }
    return visited;
}
