import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.js";
import { extractStructure } from "../src/structure.js";

const temps: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "knowstone-struct-"));
  temps.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  write("src/a.ts", `import { b } from "./b.js";\nexport const a = () => b();\n`);
  write("src/b.ts", `export const b = () => 1;\n`);
  write("lib/c.ts", `export const c = 3;\n`);
  write("api/routes.php", `<?php\nRoute::get('/', fn () => 1);\n`);
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractStructure", () => {
  it("summarises file count and language breakdown", () => {
    const summary = extractStructure(buildIndex(makeRepo()));
    expect(summary.fileCount).toBe(4);
    expect(summary.byLanguage.ts).toBe(3);
    expect(summary.byLanguage.php).toBe(1);
  });

  it("lists top-level directories most-files-first", () => {
    const summary = extractStructure(buildIndex(makeRepo()));
    expect(summary.topLevelDirs).toEqual([
      { name: "src", fileCount: 2 },
      { name: "api", fileCount: 1 },
      { name: "lib", fileCount: 1 },
    ]);
  });

  it("reports entry points as files nothing else imports", () => {
    const summary = extractStructure(buildIndex(makeRepo()));
    // b.ts is imported by a.ts, so it is not an entry point.
    expect(summary.entryPoints).toEqual(["api/routes.php", "lib/c.ts", "src/a.ts"]);
  });
});
