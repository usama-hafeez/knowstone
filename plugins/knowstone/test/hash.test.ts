import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent, hashFile, hashFiles, merkleRoot, type FileHash } from "../src/hash.js";

/** Temp directories created during a test, removed afterwards. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowstone-hash-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("hashContent", () => {
  it("is deterministic for the same input", () => {
    const a = hashContent("hello world");
    const b = hashContent("hello world");
    expect(a).toBe(b);
  });

  it("matches a string and its Buffer form", () => {
    expect(hashContent("hello world")).toBe(hashContent(Buffer.from("hello world")));
  });

  it("returns lowercase hex matching node:crypto", () => {
    const expected = createHash("sha256").update("hello world").digest("hex");
    expect(hashContent("hello world")).toBe(expected);
    expect(hashContent("hello world")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the empty string to the known sha256", () => {
    expect(hashContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("hashFile", () => {
  it("hashes a file on disk with the right size and path", () => {
    const root = makeTempDir();
    writeFileSync(join(root, "note.txt"), "some bytes");

    const result = hashFile(root, "note.txt");
    expect(result.path).toBe("note.txt");
    expect(result.hash).toBe(hashContent("some bytes"));
    expect(result.size).toBe(Buffer.byteLength("some bytes"));
  });

  it("normalises backslash paths to forward slashes", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.txt"), "content");

    const result = hashFile(root, "src\\a.txt");
    expect(result.path).toBe("src/a.txt");
    expect(result.hash).toBe(hashContent("content"));
  });

  it("throws naming the path when the file is missing", () => {
    const root = makeTempDir();
    expect(() => hashFile(root, "missing.txt")).toThrow("missing.txt");
  });
});

describe("hashFiles", () => {
  it("keys the map by normalised forward-slash path", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "a.txt"), "aaa");
    writeFileSync(join(root, "src", "b.txt"), "bbb");

    const map = hashFiles(root, ["a.txt", "src\\b.txt"]);
    expect([...map.keys()].sort()).toEqual(["a.txt", "src/b.txt"]);
    expect(map.get("a.txt")?.hash).toBe(hashContent("aaa"));
    expect(map.get("src/b.txt")?.hash).toBe(hashContent("bbb"));
  });

  it("throws naming the path when a file is missing", () => {
    const root = makeTempDir();
    writeFileSync(join(root, "a.txt"), "aaa");
    expect(() => hashFiles(root, ["a.txt", "gone.txt"])).toThrow("gone.txt");
  });
});

describe("merkleRoot", () => {
  const fileA: FileHash = { path: "a.txt", hash: hashContent("aaa"), size: 3 };
  const fileB: FileHash = { path: "b.txt", hash: hashContent("bbb"), size: 3 };
  const fileC: FileHash = { path: "c.txt", hash: hashContent("ccc"), size: 3 };

  it("returns the sha256 of the empty string for empty input", () => {
    expect(merkleRoot([])).toBe(hashContent(""));
  });

  it("is independent of the input array order", () => {
    const one = merkleRoot([fileA, fileB, fileC]);
    const two = merkleRoot([fileC, fileA, fileB]);
    const three = merkleRoot([fileB, fileC, fileA]);
    expect(two).toBe(one);
    expect(three).toBe(one);
  });

  it("changes when a single byte of one file changes", () => {
    const before = merkleRoot([fileA, fileB]);
    const changed: FileHash = { path: "b.txt", hash: hashContent("bbc"), size: 3 };
    const after = merkleRoot([fileA, changed]);
    expect(after).not.toBe(before);
  });

  it("returns lowercase hex", () => {
    expect(merkleRoot([fileA, fileB])).toMatch(/^[0-9a-f]{64}$/);
  });
});
