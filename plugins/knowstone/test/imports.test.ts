import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildImportGraph,
  dependencyCone,
  detectLanguage,
  extractImports,
  type Language,
} from "../src/imports.js";

describe("detectLanguage", () => {
  it("maps known extensions to languages", () => {
    expect(detectLanguage("a.ts")).toBe("ts");
    expect(detectLanguage("a.tsx")).toBe("ts");
    expect(detectLanguage("a.mts")).toBe("ts");
    expect(detectLanguage("a.cts")).toBe("ts");
    expect(detectLanguage("a.js")).toBe("js");
    expect(detectLanguage("a.jsx")).toBe("js");
    expect(detectLanguage("a.mjs")).toBe("js");
    expect(detectLanguage("a.cjs")).toBe("js");
    expect(detectLanguage("a.php")).toBe("php");
    expect(detectLanguage("a.py")).toBe("py");
    expect(detectLanguage("a.go")).toBe("go");
  });

  it("returns null for unknown or extensionless paths", () => {
    expect(detectLanguage("a.rb")).toBeNull();
    expect(detectLanguage("README")).toBeNull();
    expect(detectLanguage("a.TS")).toBe("ts"); // case-insensitive
  });
});

describe("extractImports", () => {
  it("extracts ts/js import, export, dynamic import and require", () => {
    const src = [
      `import a from "./a.js";`,
      `import { b } from "./b";`,
      `import "./side-effect.js";`,
      `export { c } from "./c.js";`,
      `const d = await import("./d.js");`,
      `const e = require("./e");`,
      `import x from "lodash";`,
    ].join("\n");
    const got = extractImports("ts", src);
    expect(got).toEqual(["./a.js", "./b", "./c.js", "lodash", "./side-effect.js", "./d.js", "./e"]);
  });

  it("dedupes repeated specifiers", () => {
    const src = `import a from "./a.js";\nimport { b } from "./a.js";`;
    expect(extractImports("ts", src)).toEqual(["./a.js"]);
  });

  it("extracts php use and require/include forms", () => {
    const src = [
      `use App\\Models\\User;`,
      `use App\\Services\\Mailer as Mail;`,
      `require_once "bootstrap.php";`,
      `include('helpers.php');`,
    ].join("\n");
    const got = extractImports("php", src);
    expect(got).toContain("App\\Models\\User");
    expect(got).toContain("App\\Services\\Mailer");
    expect(got).toContain("bootstrap.php");
    expect(got).toContain("helpers.php");
  });

  it("extracts python import and from-import forms", () => {
    const src = [`import os`, `import a.b.c`, `from a.b import thing`, `import json as j`].join(
      "\n",
    );
    const got = extractImports("py", src);
    expect(got).toContain("os");
    expect(got).toContain("a.b.c");
    expect(got).toContain("a.b");
    expect(got).toContain("json");
  });

  it("extracts go single and grouped imports", () => {
    const src = [`import "fmt"`, `import (`, `\t"os"`, `\talias "github.com/pkg/errors"`, `)`].join(
      "\n",
    );
    const got = extractImports("go", src);
    expect(got).toContain("fmt");
    expect(got).toContain("os");
    expect(got).toContain("github.com/pkg/errors");
  });

  it("returns [] for unknown content shapes", () => {
    expect(extractImports("py", "x = 1")).toEqual([]);
  });
});

describe("buildImportGraph + dependencyCone", () => {
  let tmp: string;
  // Repo-relative file names used throughout.
  const files = ["a.ts", "b.ts", "c.ts", "leaf.ts"];

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "knowstone-imports-"));
    // a imports b (and a bare lodash which must be dropped).
    fs.writeFileSync(
      path.join(tmp, "a.ts"),
      `import { b } from "./b.js";\nimport _ from "lodash";\n`,
    );
    // b imports c.
    fs.writeFileSync(path.join(tmp, "b.ts"), `import { c } from "./c.js";\n`);
    // c imports a — closes the cycle a -> b -> c -> a.
    fs.writeFileSync(path.join(tmp, "c.ts"), `import { a } from "./a.js";\n`);
    // leaf imports nothing.
    fs.writeFileSync(path.join(tmp, "leaf.ts"), `export const leaf = 1;\n`);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves relative ts imports (./b.js -> b.ts) and drops bare lodash", () => {
    const graph = buildImportGraph(tmp, files);
    expect(graph.edges.get("a.ts")).toEqual(new Set(["b.ts"]));
    expect(graph.edges.get("b.ts")).toEqual(new Set(["c.ts"]));
    expect(graph.edges.get("c.ts")).toEqual(new Set(["a.ts"]));
    expect(graph.edges.get("leaf.ts")).toEqual(new Set());
  });

  it("dependencyCone(a) == {a,b,c} and terminates despite the cycle", () => {
    const graph = buildImportGraph(tmp, files);
    const cone = dependencyCone(graph, "a.ts");
    expect(cone).toEqual(new Set(["a.ts", "b.ts", "c.ts"]));
  });

  it("dependencyCone of a leaf is just itself", () => {
    const graph = buildImportGraph(tmp, files);
    expect(dependencyCone(graph, "leaf.ts")).toEqual(new Set(["leaf.ts"]));
  });

  it("dependencyCone of a file not in the graph returns just itself", () => {
    const graph = buildImportGraph(tmp, files);
    expect(dependencyCone(graph, "ghost.ts")).toEqual(new Set(["ghost.ts"]));
  });

  it("drops relative specifiers that resolve outside the input file set", () => {
    const only = ["a.ts"];
    const graph = buildImportGraph(tmp, only);
    // b.ts is not in the set, so a.ts has no kept edges.
    expect(graph.edges.get("a.ts")).toEqual(new Set());
  });
});

// Compile-time guard that the exported Language type is usable.
const _lang: Language = "ts";
void _lang;
