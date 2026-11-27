/**
 * Knowstone — route extractor.
 *
 * Projects a project Index into a flat, deterministic list of HTTP route
 * declarations found in its source, best-effort per framework:
 *  - Laravel PHP: `Route::<verb>('/path', handler)` for get/post/put/patch/
 *    delete/options/head/any, plus `Route::match(['get','post'], '/path', ...)`
 *    which emits one route per listed method.
 *  - Express / Fastify (ts/js): `<receiver>.<verb>('/path', handler)` for the
 *    same verbs plus `all`, where the receiver is any identifier (app, router,
 *    fastify, r, ...). `.use` is a middleware mount, not a route, and is skipped.
 *  - NestJS (ts/js): a `@Controller('prefix')` class whose methods carry route
 *    decorators `@Get()`, `@Post(':id')`, ... for get/post/put/patch/delete/
 *    options/head/all. The reported path is the controller prefix joined to the
 *    method path ("/" when both are empty); the handler is the method name. A
 *    `@Controller({ path: 'x' })` object form is read for its `path`.
 *
 * Matching is regex-based and line-aware so each route reports the 1-based line
 * where its call starts. This mirrors the straightforward extraction style in
 * ./imports.ts. To avoid matching ordinary method calls that merely share a verb
 * name (`cache.get('key')`, `req.get('Accept')`, `map.get('id')`), a JS route's
 * path must begin with "/" or "*"; Laravel's `Route::` prefix and a NestJS `@Get`
 * decorator are unambiguous on their own and keep paths as written. Known
 * limitations: commented-out route calls are still matched (comments are not
 * stripped); chained calls like `router.route('/x').get()` are not recognised
 * (the verb must follow a plain identifier receiver); an HTTP-client call to an
 * absolute path (`axios.get('/x')`) can still be picked up as a JS route; a path
 * string containing an escaped quote (`'/it\'s'`) is truncated at that quote; and
 * for NestJS an array path (`@Controller(['a','b'])` / `@Get(['x','y'])`) keeps
 * only its first string, a decorator or controller argument containing a literal
 * `)` is not parsed, a `}` inside a string, template or comment in a controller
 * body can confuse the class-body matcher, a generic method name (`findAll<T>()`)
 * or an intervening decorator whose own arguments contain a `)`
 * (`@UseGuards(new Guard())`) leaves the handler as "unknown", and the class-body
 * opening brace is found past generic/parenthesised headers but not past a `{`
 * that appears inside a string in the class header.
 */

import fs from "node:fs";
import path from "node:path";
import { detectLanguage } from "./imports.js";
import type { Index } from "./indexer.js";

export interface Route {
  /** UPPERCASE HTTP method, e.g. "GET", "POST". Route::any -> "ANY", app.all -> "ALL". */
  method: string;
  /** The route path string exactly as written in source (contents of the quotes). */
  path: string;
  /** Best-effort handler description: an identifier, a raw argument, "closure" or "unknown". */
  handler: string;
  /** Repo-relative, forward slashes (same form as index.files entries). */
  file: string;
  /** 1-based line number where the route call starts. */
  line: number;
}

/** The HTTP verbs we recognise in Laravel route calls (match is handled separately). */
const LARAVEL_VERBS = "get|post|put|patch|delete|options|head|any";
/** The HTTP verbs we recognise in Express/Fastify route calls. */
const JS_VERBS = "get|post|put|patch|delete|options|head|all";
/** The NestJS method decorators we recognise (@Get(), @Post(), ...). */
const NEST_VERBS = "Get|Post|Put|Patch|Delete|Options|Head|All";

/** Count the 1-based line number of a character index within content. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Given the text immediately after a route path's closing quote, return the
 * next argument (the handler) as a single trimmed line, or null if there is no
 * further argument. Only this one line is considered; a handler spanning more
 * lines is reported from its first line.
 */
function nextArgSegment(rest: string): string | null {
  const comma = /^\s*,\s*/.exec(rest);
  if (comma === null) return null;
  const after = rest.slice(comma[0].length);
  const nl = after.indexOf("\n");
  return (nl === -1 ? after : after.slice(0, nl)).trim();
}

/** Strip a trailing `;` and closing `)` characters left over from the call. */
function stripTrailing(segment: string): string {
  return segment.trim().replace(/;+$/, "").trim().replace(/\)+$/, "").trim();
}

/** Describe a Laravel handler argument (the text after the path). */
function laravelHandler(rest: string): string {
  const segment = nextArgSegment(rest);
  if (segment === null) return "unknown";
  if (/^(fn|function)\b/.test(segment)) return "closure";
  const cleaned = stripTrailing(segment);
  if (cleaned === "") return "unknown";
  const quoted = /^(['"])([\s\S]*)\1$/.exec(cleaned);
  if (quoted !== null) return quoted[2] ?? cleaned;
  return cleaned;
}

/** Describe an Express/Fastify handler argument (the text after the path). */
function jsHandler(rest: string): string {
  const segment = nextArgSegment(rest);
  if (segment === null) return "unknown";
  // Inline function/arrow handlers: `function (...)`, `(...) => ...`, `{...}`.
  if (/^(async\b|function\b|\(|\{)/.test(segment) || /=>/.test(segment)) return "closure";
  const id = /^([A-Za-z_$][\w$.]*)/.exec(segment);
  const name = id?.[1];
  if (name !== undefined) {
    const rem = segment.slice(name.length).trim();
    if (rem === "" || rem.startsWith(",") || rem.startsWith(")") || rem.startsWith(";")) {
      return name;
    }
  }
  return "unknown";
}

/** Extract Laravel routes from one PHP file's content into out. */
function extractFromPhp(content: string, file: string, out: Route[]): void {
  const verbRe = new RegExp(`\\bRoute::(${LARAVEL_VERBS})\\s*\\(\\s*(['"])([\\s\\S]*?)\\2`, "g");
  let m: RegExpExecArray | null;
  while ((m = verbRe.exec(content)) !== null) {
    out.push({
      method: (m[1] ?? "").toUpperCase(),
      path: m[3] ?? "",
      handler: laravelHandler(content.slice(verbRe.lastIndex)),
      file,
      line: lineAt(content, m.index),
    });
  }

  // Route::match(['get','post'], '/path', handler) -> one route per method.
  const matchRe = /\bRoute::match\s*\(\s*\[([^\]]*)\]\s*,\s*(['"])([\s\S]*?)\2/g;
  while ((m = matchRe.exec(content)) !== null) {
    const methods = (m[1] ?? "")
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^['"]|['"]$/g, "")
          .trim(),
      )
      .filter((s) => s !== "");
    const routePath = m[3] ?? "";
    const handler = laravelHandler(content.slice(matchRe.lastIndex));
    const line = lineAt(content, m.index);
    for (const method of methods) {
      out.push({ method: method.toUpperCase(), path: routePath, handler, file, line });
    }
  }
}

/**
 * A JS route path must look route-like: begin with "/" (every Express and
 * Fastify route path does) or be a "*" catch-all. This is what separates a real
 * `app.get('/x', h)` route from an ordinary method call that shares a verb name
 * and takes a string, e.g. `cache.get('key')`, `req.get('Accept')`,
 * `map.get('id')` or `searchParams.get('q')`. Without it the matcher emits a
 * false route for every such call.
 */
function isRouteLikePath(routePath: string): boolean {
  return routePath.startsWith("/") || routePath.startsWith("*");
}

/** Extract Express/Fastify routes from one ts/js file's content into out. */
function extractFromJs(content: string, file: string, out: Route[]): void {
  const re = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\.(${JS_VERBS})\\s*\\(\\s*(['"\`])([\\s\\S]*?)\\3`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const routePath = m[4] ?? "";
    if (!isRouteLikePath(routePath)) continue;
    out.push({
      method: (m[2] ?? "").toUpperCase(),
      path: routePath,
      handler: jsHandler(content.slice(re.lastIndex)),
      file,
      line: lineAt(content, m.index),
    });
  }
}

/** Index of the matching `}` for the `{` at openIndex (depth-aware), or -1. */
function matchBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the `{` that opens a class body, searching from `from` (just after the
 * `@Controller(...)` decorator). A `{` inside a generic argument (`<...>`) or a
 * parenthesised list in the class header — e.g. `extends Repository<{ id: number }>`
 * or another decorator like `@Injectable({ ... })` — is skipped by only accepting
 * a `{` seen at angle depth 0 and paren depth 0. Returns -1 if none is found.
 */
function classBodyBrace(content: string, from: number): number {
  let angle = 0;
  let paren = 0;
  for (let i = from; i < content.length; i++) {
    const ch = content[i];
    if (ch === "<") angle++;
    else if (ch === ">") {
      if (angle > 0) angle--;
    } else if (ch === "(") paren++;
    else if (ch === ")") {
      if (paren > 0) paren--;
    } else if (ch === "{" && angle === 0 && paren === 0) {
      return i;
    }
  }
  return -1;
}

/** First single/double quoted string's contents in text, or "" if none. */
function firstQuoted(text: string): string {
  const m = /['"]([^'"]*)['"]/.exec(text);
  return m ? (m[1] ?? "") : "";
}

/**
 * The controller prefix from a `@Controller(...)` argument list: a leading string
 * literal (`@Controller('cats')`), the first string of an array form
 * (`@Controller(['cats', 'kittens'])`), or the `path` of an object form
 * (`@Controller({ path: 'cats' })`). Empty for `@Controller()`.
 */
function nestControllerPrefix(args: string): string {
  const trimmed = args.trim();
  const leading = /^['"]([^'"]*)['"]/.exec(trimmed);
  if (leading !== null) return leading[1] ?? "";
  if (trimmed.startsWith("[")) return firstQuoted(trimmed);
  const objectPath = /\bpath\s*:\s*['"]([^'"]*)['"]/.exec(trimmed);
  if (objectPath !== null) return objectPath[1] ?? "";
  return "";
}

/** Join a controller prefix and a method path the way NestJS mounts them. */
function joinNestPath(prefix: string, methodPath: string): string {
  const parts = [prefix, methodPath]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "");
  return "/" + parts.join("/");
}

/**
 * The handler (method) name that follows a route decorator: skip any intervening
 * decorators (`@UseGuards(...)`, `@HttpCode(204)`) and member modifiers, then take
 * the identifier declared before its parameter list. "unknown" if none is found.
 */
function nestHandlerName(after: string): string {
  const re =
    /^\s*(?:@[A-Za-z_$][\w$]*\s*(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|readonly|static|async|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\(/;
  const m = re.exec(after);
  return m ? (m[1] ?? "unknown") : "unknown";
}

/** Extract NestJS controller routes from one ts/js file's content into out. */
function extractFromNest(content: string, file: string, out: Route[]): void {
  const controllerRe = /@Controller\s*\(([^)]*)\)/g;
  let c: RegExpExecArray | null;
  while ((c = controllerRe.exec(content)) !== null) {
    const prefix = nestControllerPrefix(c[1] ?? "");
    const braceOpen = classBodyBrace(content, controllerRe.lastIndex);
    if (braceOpen === -1) continue;
    const braceClose = matchBrace(content, braceOpen);
    if (braceClose === -1) continue;

    const body = content.slice(braceOpen + 1, braceClose);
    const verbRe = new RegExp(`@(${NEST_VERBS})\\s*\\(([^)]*)\\)`, "g");
    let v: RegExpExecArray | null;
    while ((v = verbRe.exec(body)) !== null) {
      out.push({
        method: (v[1] ?? "").toUpperCase(),
        path: joinNestPath(prefix, firstQuoted(v[2] ?? "")),
        handler: nestHandlerName(body.slice(verbRe.lastIndex)),
        file,
        line: lineAt(content, braceOpen + 1 + v.index),
      });
    }

    controllerRe.lastIndex = braceClose; // continue scanning after this class
  }
}

/**
 * Extract every route declaration across the index's source files. Only .php
 * (Laravel) and .ts/.js (Express/Fastify and NestJS) files are scanned; other
 * languages contribute nothing. Unreadable files are skipped (best-effort, never
 * throws). The result is sorted by file, then line, then method for determinism.
 */
export function extractRoutes(index: Index): Route[] {
  const routes: Route[] = [];

  for (const file of index.files) {
    const language = detectLanguage(file);
    if (language !== "php" && language !== "ts" && language !== "js") continue;

    let content: string;
    try {
      content = fs.readFileSync(path.join(index.root, file), "utf8");
    } catch {
      continue; // unreadable file: skip, best-effort
    }

    if (language === "php") {
      extractFromPhp(content, file, routes);
    } else {
      extractFromJs(content, file, routes);
      extractFromNest(content, file, routes);
    }
  }

  routes.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
  );

  return routes;
}
