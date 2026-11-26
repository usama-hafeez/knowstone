import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, listSourceFiles } from "../src/indexer.js";

const temps: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-index-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  write("src/a.ts", `import { b } from "./b.js";\nexport const a = () => b();\n`);
  write("src/b.ts", `export const b = () => 1;\n`);
  write("src/nested/c.ts", `export const c = 3;\n`);
  write("README.md", "# docs\n"); // not a source file
  write("node_modules/pkg/index.js", "module.exports = 1;\n"); // ignored dir
  write("dist/bundle.js", "console.log(1);\n"); // ignored dir
  write(".git/config", "[core]\n"); // hidden dir
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("listSourceFiles", () => {
  it("returns source files and skips node_modules, build output, hidden dirs and non-source", () => {
    const files = listSourceFiles(makeRepo());
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  it("skips files larger than maxFileBytes", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, "src", "big.ts"),
      `export const big = "${"x".repeat(5000)}";\n`,
      "utf8",
    );
    const files = listSourceFiles(root, { maxFileBytes: 1000 });
    expect(files).not.toContain("src/big.ts");
    expect(files).toContain("src/a.ts"); // small files are still included
  });

  it("honours extra ignore dirs", () => {
    const root = makeRepo();
    writeFileSync(join(root, "src", "generated.ts"), "export const g = 1;\n", "utf8");
    const files = listSourceFiles(root, { ignoreDirs: ["nested"] });
    expect(files).not.toContain("src/nested/c.ts");
    expect(files).toContain("src/generated.ts");
  });
});

describe("buildIndex", () => {
  it("builds the file list and the import graph together", () => {
    const index = buildIndex(makeRepo());
    expect(index.files).toContain("src/a.ts");
    expect(index.graph.edges.get("src/a.ts")?.has("src/b.ts")).toBe(true);
  });
});
