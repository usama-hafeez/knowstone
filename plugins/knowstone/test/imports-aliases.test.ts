import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportGraph, dependencyCone, loadAliasConfig } from "../src/imports.js";

/**
 * tsconfig path-alias resolution: imports like `@/b` and `@config` should resolve
 * to real repo files so the dependency cone is complete (and facts stay precise
 * instead of being withheld).
 */

const temps: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-alias-"));
  temps.push(root);
  mkdirSync(join(root, "src"));
  // tsconfig with a comment and trailing commas, to exercise the tolerant parser.
  writeFileSync(
    join(root, "tsconfig.json"),
    `{
  // knowstone alias fixture
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@config": ["src/config.ts"],
    },
  },
}
`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "a.ts"),
    `import { b } from "@/b";\nimport { c } from "@config";\nexport const a = () => b() + c();\n`,
    "utf8",
  );
  writeFileSync(join(root, "src", "b.ts"), `export const b = () => 1;\n`, "utf8");
  writeFileSync(join(root, "src", "config.ts"), `export const c = () => 2;\n`, "utf8");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const FILES = ["src/a.ts", "src/b.ts", "src/config.ts"];

describe("tsconfig path aliases", () => {
  it("parses baseUrl and paths, tolerating comments and trailing commas", () => {
    const config = loadAliasConfig(makeRepo());
    expect(config?.baseUrl).toBe(".");
    expect(config?.paths["@/*"]).toEqual(["src/*"]);
    expect(config?.paths["@config"]).toEqual(["src/config.ts"]);
  });

  it("returns null when there is no tsconfig or no paths", () => {
    const root = mkdtempSync(join(tmpdir(), "knowstone-noalias-"));
    temps.push(root);
    expect(loadAliasConfig(root)).toBeNull();
  });

  it("resolves a wildcard alias so the cone is complete", () => {
    const graph = buildImportGraph(makeRepo(), FILES);
    expect([...(graph.edges.get("src/a.ts") ?? [])].sort()).toEqual(["src/b.ts", "src/config.ts"]);
    expect(graph.incomplete.has("src/a.ts")).toBe(false);
    expect([...dependencyCone(graph, "src/a.ts")].sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/config.ts",
    ]);
  });

  it("marks the file incomplete when alias resolution is disabled", () => {
    const graph = buildImportGraph(makeRepo(), FILES, { aliases: null });
    expect(graph.incomplete.has("src/a.ts")).toBe(true);
    expect(graph.edges.get("src/a.ts")?.size).toBe(0);
  });

  it("marks incomplete when an alias pattern matches but the target file is missing", () => {
    const root = makeRepo();
    appendFileSync(join(root, "src", "a.ts"), `import { z } from "@/missing";\n`, "utf8");
    const graph = buildImportGraph(root, FILES);
    // The real aliased deps still resolve, but the missing one withholds.
    expect(graph.edges.get("src/a.ts")?.has("src/b.ts")).toBe(true);
    expect(graph.incomplete.has("src/a.ts")).toBe(true);
  });
});
