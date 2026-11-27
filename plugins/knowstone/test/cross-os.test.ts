import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, projectDir, projectKey, type FactInput } from "../src/store.js";
import { hashFile } from "../src/hash.js";
import { buildImportGraph } from "../src/imports.js";
import { buildBinding, checkFreshness, type RepoSnapshot } from "../src/freshness.js";

/**
 * M5 cross-OS path/FS edge cases. Paths arrive in different shapes on Windows,
 * macOS and Linux (separators, trailing slashes, case). The data-dir key and the
 * freshness engine must agree about what counts as the same path WITHOUT ever
 * merging two genuinely distinct projects on a case-sensitive filesystem.
 * See ../../../PLAN.md (M5).
 */

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const temps: string[] = [];

function tmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowstone-xos-"));
  temps.push(dir);
  return dir;
}

function input(statement: string): FactInput {
  return {
    kind: "finding",
    statement,
    binding: { toolVersion: "0.1.0", createdAt: 1, cone: [], coneRoot: "r", coneComplete: true },
    createdAt: 1,
  };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Project key normalisation
// ---------------------------------------------------------------------------

describe("project key path normalisation (all platforms)", () => {
  it("ignores a trailing slash", () => {
    expect(projectKey("/proj/one/")).toBe(projectKey("/proj/one"));
    expect(projectKey("/proj/one///")).toBe(projectKey("/proj/one"));
  });

  it("treats backslash and forward-slash spellings of a path as the same project", () => {
    expect(projectKey("C:\\work\\app")).toBe(projectKey("C:/work/app"));
  });
});

describe("project key case handling matches the filesystem", () => {
  it("folds case only on case-insensitive filesystems (never merges distinct Linux paths)", () => {
    if (CASE_INSENSITIVE) {
      // Windows / macOS: "/p/App" and "/p/app" are the same directory.
      expect(projectKey("/p/App")).toBe(projectKey("/p/app"));
    } else {
      // Linux: they are genuinely different projects and must not collide.
      expect(projectKey("/p/App")).not.toBe(projectKey("/p/app"));
    }
  });
});

// ---------------------------------------------------------------------------
// Store isolation under path-shape differences
// ---------------------------------------------------------------------------

describe("store keys the same project across path spellings", () => {
  it("serves facts written via a trailing-slash root when read without the slash", () => {
    const base = tmpBase();
    openStore({ baseDir: base, projectRoot: "/proj/one/" }).put(input("slash-written finding"));
    const read = openStore({ baseDir: base, projectRoot: "/proj/one" }).list();
    expect(read.map((f) => f.statement)).toEqual(["slash-written finding"]);
    // Same resolved data directory either way.
    expect(projectDir({ baseDir: base, projectRoot: "/proj/one/" })).toBe(
      projectDir({ baseDir: base, projectRoot: "/proj/one" }),
    );
  });

  it("does not raise a false collision for the same project reached with different casing", () => {
    const base = tmpBase();
    openStore({ baseDir: base, projectRoot: "/proj/App" }).put(input("first"));

    if (CASE_INSENSITIVE) {
      // Same dir on disk: the marker ("/proj/App") must not reject the "/proj/app"
      // spelling, and the earlier fact is visible.
      const same = openStore({ baseDir: base, projectRoot: "/proj/app" });
      expect(same.list().map((f) => f.statement)).toEqual(["first"]);
    } else {
      // Case-sensitive FS: a different-cased path is a different project, isolated.
      const other = openStore({ baseDir: base, projectRoot: "/proj/app" });
      expect(other.list()).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Hashing and cones under mixed separators
// ---------------------------------------------------------------------------

describe("hashing and cones normalise separators", () => {
  it("hashes the same file identically whether the relative path uses / or \\", () => {
    const root = mkdtempSync(join(tmpdir(), "knowstone-xos-repo-"));
    temps.push(root);
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "x.ts"), "export const x = 1;\n", "utf8");

    const forward = hashFile(root, "sub/x.ts");
    const backward = hashFile(root, "sub\\x.ts");
    // Repo-relative paths are always stored with forward slashes, and the bytes
    // read are the same, so both spellings agree.
    expect(backward.path).toBe("sub/x.ts");
    expect(backward.hash).toBe(forward.hash);
  });

  it("tracks a dependency given as evidence with backslashes", () => {
    const root = mkdtempSync(join(tmpdir(), "knowstone-xos-cone-"));
    temps.push(root);
    writeFileSync(
      join(root, "a.ts"),
      `import { b } from "./b.js";\nexport const a = () => b();\n`,
      "utf8",
    );
    writeFileSync(join(root, "b.ts"), "export const b = () => 1;\n", "utf8");

    const graph = buildImportGraph(root, ["a.ts", "b.ts"]);
    // Evidence passed with a backslash must still resolve to the a.ts node and pull
    // in its dependency b.ts.
    const binding = buildBinding({ root, toolVersion: "0.1.0", now: 1000 }, [".\\a.ts"], graph);
    expect(binding.cone.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);

    const snapshot: RepoSnapshot = { root, toolVersion: "0.1.0", now: 1000 };
    expect(checkFreshness(binding, snapshot).status).toBe("FRESH");
    writeFileSync(join(root, "b.ts"), "export const b = () => 2;\n", "utf8");
    expect(checkFreshness(binding, snapshot).status).toBe("STALE");
  });
});
