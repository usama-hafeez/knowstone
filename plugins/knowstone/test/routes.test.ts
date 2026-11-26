import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractRoutes } from "../src/routes.js";

const temps: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-routes-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  write(
    "api/routes.php",
    [
      "<?php",
      "Route::get('/users', 'UserController@index');",
      "Route::post('/users', fn () => 1);",
      "Route::any('/ping', 'PingController@handle');",
      "Route::match(['get', 'post'], '/match', 'MatchController@do');",
      "",
    ].join("\n"),
  );
  write(
    "src/app.js",
    [
      "app.get('/health', healthHandler);",
      "router.post('/items', (req, res) => res.send('ok'));",
      "fastify.all('/all', handleAll);",
      "app.use('/mw', someMiddleware);",
      "const v = cache.get('session:' + id);",
      "const ct = req.get('Content-Type');",
      "const u = userMap.get('alice');",
      "",
    ].join("\n"),
  );
  write("src/util.ts", "export const x = 1;\n");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractRoutes", () => {
  it("extracts Laravel get/post/any with handlers and line numbers", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    expect(routes).toContainEqual({
      method: "GET",
      path: "/users",
      handler: "UserController@index",
      file: "api/routes.php",
      line: 2,
    });
    expect(routes).toContainEqual({
      method: "POST",
      path: "/users",
      handler: "closure",
      file: "api/routes.php",
      line: 3,
    });
    expect(routes).toContainEqual({
      method: "ANY",
      path: "/ping",
      handler: "PingController@handle",
      file: "api/routes.php",
      line: 4,
    });
  });

  it("expands Route::match into one route per listed method", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    const matched = routes.filter((r) => r.path === "/match");
    expect(matched).toEqual([
      {
        method: "GET",
        path: "/match",
        handler: "MatchController@do",
        file: "api/routes.php",
        line: 5,
      },
      {
        method: "POST",
        path: "/match",
        handler: "MatchController@do",
        file: "api/routes.php",
        line: 5,
      },
    ]);
  });

  it("extracts Express/Fastify routes, handler as identifier and as closure", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    expect(routes).toContainEqual({
      method: "GET",
      path: "/health",
      handler: "healthHandler",
      file: "src/app.js",
      line: 1,
    });
    expect(routes).toContainEqual({
      method: "POST",
      path: "/items",
      handler: "closure",
      file: "src/app.js",
      line: 2,
    });
    expect(routes).toContainEqual({
      method: "ALL",
      path: "/all",
      handler: "handleAll",
      file: "src/app.js",
      line: 3,
    });
  });

  it("ignores ordinary .get/.post calls whose path is not route-like", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    // cache.get('session:'...), req.get('Content-Type') and userMap.get('alice')
    // share a verb name but their string arg is not a route path.
    expect(routes.some((r) => r.file === "src/app.js" && !r.path.startsWith("/"))).toBe(false);
    expect(routes.some((r) => r.path === "Content-Type")).toBe(false);
    expect(routes.some((r) => r.path.startsWith("session"))).toBe(false);
    expect(routes.some((r) => r.path === "alice")).toBe(false);
  });

  it("skips .use middleware mounts", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    expect(routes.some((r) => r.path === "/mw")).toBe(false);
  });

  it("contributes nothing for files with no routes", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    expect(routes.some((r) => r.file === "src/util.ts")).toBe(false);
  });

  it("returns routes sorted by file, then line, then method", () => {
    const routes = extractRoutes(buildIndex(makeRepo()));
    const order = routes.map((r) => [r.file, r.line, r.method]);
    const sorted = [...order].sort(
      (a, b) =>
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) ||
        (a[1] as number) - (b[1] as number) ||
        (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0),
    );
    expect(order).toEqual(sorted);
    // php file sorts before the js file.
    expect(routes[0]?.file).toBe("api/routes.php");
  });
});
