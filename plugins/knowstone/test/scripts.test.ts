import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractScripts, findPackageJsonFiles } from "../src/scripts.js";

const temps: string[] = [];

function makeRepo(): { root: string; write: (rel: string, content: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "knowstone-scripts-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  return { root, write };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractScripts", () => {
  it("extracts scripts from the root package.json, sorted by name", () => {
    const { root, write } = makeRepo();
    write(
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: { test: "vitest run", build: "tsc", lint: "eslint ." },
      }),
    );
    const scripts = extractScripts(buildIndex(root));
    expect(scripts).toEqual([
      { file: "package.json", name: "build", command: "tsc" },
      { file: "package.json", name: "lint", command: "eslint ." },
      { file: "package.json", name: "test", command: "vitest run" },
    ]);
  });

  it("extracts scripts from nested workspace packages, grouped by sorted path", () => {
    const { root, write } = makeRepo();
    write("package.json", JSON.stringify({ scripts: { build: "turbo run build" } }));
    write("packages/api/package.json", JSON.stringify({ scripts: { start: "node ." } }));
    write("packages/web/package.json", JSON.stringify({ scripts: { dev: "vite" } }));

    const scripts = extractScripts(buildIndex(root));
    expect(scripts).toEqual([
      { file: "package.json", name: "build", command: "turbo run build" },
      { file: "packages/api/package.json", name: "start", command: "node ." },
      { file: "packages/web/package.json", name: "dev", command: "vite" },
    ]);
  });

  it("ignores package.json files inside node_modules and hidden dirs", () => {
    const { root, write } = makeRepo();
    write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    write("node_modules/dep/package.json", JSON.stringify({ scripts: { evil: "rm -rf /" } }));
    write(".cache/package.json", JSON.stringify({ scripts: { nope: "x" } }));

    const files = findPackageJsonFiles(root);
    expect(files).toEqual(["package.json"]);
    const scripts = extractScripts(buildIndex(root));
    expect(scripts.map((s) => s.name)).toEqual(["build"]);
  });

  it("skips a package.json with no scripts, an empty scripts object, or non-string values", () => {
    const { root, write } = makeRepo();
    write("package.json", JSON.stringify({ name: "no-scripts" }));
    write("a/package.json", JSON.stringify({ scripts: {} }));
    write("b/package.json", JSON.stringify({ scripts: { ok: "echo hi", bad: 42, arr: [] } }));

    const scripts = extractScripts(buildIndex(root));
    expect(scripts).toEqual([{ file: "b/package.json", name: "ok", command: "echo hi" }]);
  });

  it("skips a top-level scripts value that is an array, not an object", () => {
    const { root, write } = makeRepo();
    write("package.json", JSON.stringify({ scripts: ["vitest run", "tsc"] }));
    write("ok/package.json", JSON.stringify({ scripts: { go: "node ." } }));

    // The array must not become scripts named "0"/"1".
    const scripts = extractScripts(buildIndex(root));
    expect(scripts).toEqual([{ file: "ok/package.json", name: "go", command: "node ." }]);
  });

  it("skips a malformed package.json without throwing", () => {
    const { root, write } = makeRepo();
    write("package.json", "{ not valid json ");
    write("ok/package.json", JSON.stringify({ scripts: { go: "node ." } }));

    const scripts = extractScripts(buildIndex(root));
    expect(scripts).toEqual([{ file: "ok/package.json", name: "go", command: "node ." }]);
  });

  it("returns an empty list when there is no package.json", () => {
    const { root, write } = makeRepo();
    write("src/a.ts", "export const a = 1;\n");
    expect(extractScripts(buildIndex(root))).toEqual([]);
  });
});
