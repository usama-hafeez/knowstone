import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractRoutes } from "../src/routes.js";

const temps: string[] = [];

function makeRepo(write: (w: (rel: string, content: string) => void) => void): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-nest-"));
  temps.push(root);
  write((rel, content) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  });
  return root;
}

/** Map routes to compact strings for readable assertions. */
function summarise(root: string): string[] {
  return extractRoutes(buildIndex(root))
    .map((r) => `${r.method} ${r.path} -> ${r.handler} @ ${r.file}`)
    .sort();
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractRoutes — NestJS decorators", () => {
  it("joins the controller prefix to method paths and reads the method name as handler", () => {
    const root = makeRepo((w) =>
      w(
        "src/cats.controller.ts",
        [
          `import { Controller, Get, Post } from "@nestjs/common";`,
          ``,
          `@Controller('cats')`,
          `export class CatsController {`,
          `  @Get()`,
          `  findAll() {}`,
          ``,
          `  @Get(':id')`,
          `  findOne(@Param('id') id: string) {}`,
          ``,
          `  @Post()`,
          `  create(@Body() dto: CreateCatDto) {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual([
      "GET /cats -> findAll @ src/cats.controller.ts",
      "GET /cats/:id -> findOne @ src/cats.controller.ts",
      "POST /cats -> create @ src/cats.controller.ts",
    ]);
  });

  it("handles an empty @Controller() prefix and a root @Get()", () => {
    const root = makeRepo((w) =>
      w(
        "src/app.controller.ts",
        [
          `@Controller()`,
          `export class AppController {`,
          `  @Get()`,
          `  root() {}`,
          `  @Get('health')`,
          `  health() {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual([
      "GET / -> root @ src/app.controller.ts",
      "GET /health -> health @ src/app.controller.ts",
    ]);
  });

  it("reads the path from a @Controller({ path: '...' }) object form", () => {
    const root = makeRepo((w) =>
      w(
        "src/users.controller.ts",
        [
          `@Controller({ path: 'users', version: '1' })`,
          `export class UsersController {`,
          `  @Delete(':id')`,
          `  remove() {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual(["DELETE /users/:id -> remove @ src/users.controller.ts"]);
  });

  it("skips intervening decorators and modifiers to find the handler name", () => {
    const root = makeRepo((w) =>
      w(
        "src/secure.controller.ts",
        [
          `@Controller('secure')`,
          `export class SecureController {`,
          `  @Get('data')`,
          `  @UseGuards(AuthGuard)`,
          `  @HttpCode(200)`,
          `  async getData() {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual(["GET /secure/data -> getData @ src/secure.controller.ts"]);
  });

  it("extracts from multiple controllers in one file", () => {
    const root = makeRepo((w) =>
      w(
        "src/multi.ts",
        [
          `@Controller('a')`,
          `export class A {`,
          `  @Get()`,
          `  a() {}`,
          `}`,
          `@Controller('b')`,
          `export class B {`,
          `  @Post('x')`,
          `  b() {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual([
      "GET /a -> a @ src/multi.ts",
      "POST /b/x -> b @ src/multi.ts",
    ]);
  });

  it("does not treat a parameter decorator or a non-controller class as a route", () => {
    const root = makeRepo((w) =>
      w(
        "src/service.ts",
        [
          `export class CatsService {`,
          `  findAll() { return []; }`,
          `}`,
          ``,
          `function handler(@Param('id') id: string) { return id; }`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual([]);
  });

  it("reports the 1-based line of each route decorator", () => {
    const root = makeRepo((w) =>
      w(
        "src/line.controller.ts",
        [
          `@Controller('x')`, // line 1
          `export class X {`, // line 2
          `  @Get('y')`, // line 3
          `  y() {}`, // line 4
          `}`, // line 5
          ``,
        ].join("\n"),
      ),
    );
    const routes = extractRoutes(buildIndex(root));
    expect(routes).toEqual([
      { method: "GET", path: "/x/y", handler: "y", file: "src/line.controller.ts", line: 3 },
    ]);
  });

  it("finds routes when the class header has a generic brace before the body", () => {
    const root = makeRepo((w) =>
      w(
        "src/cats.controller.ts",
        [
          `@Controller('cats')`,
          `export class CatsController extends Repository<{ id: number }> {`,
          `  @Get()`,
          `  findAll() {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    // The `{` inside the generic must not be mistaken for the class body.
    expect(summarise(root)).toEqual(["GET /cats -> findAll @ src/cats.controller.ts"]);
  });

  it("keeps the first path of an array @Controller([...]) prefix", () => {
    const root = makeRepo((w) =>
      w(
        "src/multi.controller.ts",
        [
          `@Controller(['cats', 'kittens'])`,
          `export class CatsController {`,
          `  @Get(':id')`,
          `  findOne() {}`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
    expect(summarise(root)).toEqual(["GET /cats/:id -> findOne @ src/multi.controller.ts"]);
  });

  it("coexists with Express routes without double counting", () => {
    const root = makeRepo((w) => {
      w(
        "src/nest.controller.ts",
        [`@Controller('n')`, `export class N {`, `  @Get()`, `  n() {}`, `}`, ``].join("\n"),
      );
      w("src/express.ts", [`app.get('/e', eHandler);`, ``].join("\n"));
    });
    expect(summarise(root)).toEqual([
      "GET /e -> eHandler @ src/express.ts",
      "GET /n -> n @ src/nest.controller.ts",
    ]);
  });
});
