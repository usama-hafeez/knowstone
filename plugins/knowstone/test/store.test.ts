import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SecretError, type FactInput } from "../src/store.js";
import type { Binding } from "../src/freshness.js";

const temps: string[] = [];

function tmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowstone-store-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function binding(): Binding {
  return {
    toolVersion: "0.1.0",
    createdAt: 1000,
    cone: [{ path: "a.ts", hash: "abc", size: 10 }],
    coneRoot: "root",
    coneComplete: true,
  };
}

function input(statement: string): FactInput {
  return { kind: "finding", statement, binding: binding(), createdAt: 1000 };
}

describe("persistence and retrieval", () => {
  it("stores a fact and reloads it from disk in a fresh store", () => {
    const base = tmpBase();
    const projectRoot = "/proj/one";
    const store = openStore({ baseDir: base, projectRoot });
    const fact = store.put(input("Routes are registered in routes/web.php"));
    expect(store.get(fact.id)?.statement).toContain("web.php");
    expect(existsSync(store.path)).toBe(true);

    const reopened = openStore({ baseDir: base, projectRoot });
    expect(reopened.get(fact.id)?.statement).toContain("web.php");
  });
});

describe("secret guard on the write path", () => {
  it("refuses a fact whose text contains a secret, and writes nothing", () => {
    const base = tmpBase();
    const store = openStore({ baseDir: base, projectRoot: "/proj/one" });
    expect(() => store.put(input("creds AKIAIOSFODNN7EXAMPLE in the handler"))).toThrow(
      SecretError,
    );
    expect(store.list()).toHaveLength(0);
    expect(existsSync(store.path)).toBe(false); // nothing was persisted
  });

  it("refuses a supersede whose new text contains a secret, leaving the original intact", () => {
    const base = tmpBase();
    const store = openStore({ baseDir: base, projectRoot: "/proj/one" });
    const v1 = store.put(input("clean original finding"));
    const secret = `token ghp_${"a".repeat(36)}`;
    expect(() => store.supersede(v1.id, input(secret))).toThrow(SecretError);
    expect(store.get(v1.id)?.supersededBy).toBeNull();
    expect(store.list()).toHaveLength(1);
  });
});

describe("supersede never deletes", () => {
  it("marks the old fact superseded and hides it from the default list", () => {
    const base = tmpBase();
    const store = openStore({ baseDir: base, projectRoot: "/proj/one" });
    const v1 = store.put(input("old decision"));
    const v2 = store.supersede(v1.id, input("new decision"));

    expect(store.get(v1.id)?.supersededBy).toBe(v2.id);
    expect(store.list().map((f) => f.id)).toEqual([v2.id]);
    expect(
      store
        .list({ includeSuperseded: true })
        .map((f) => f.id)
        .sort(),
    ).toEqual([v1.id, v2.id].sort());
  });
});

describe("per-project isolation", () => {
  it("does not serve one project's facts to another under the same base dir", () => {
    const base = tmpBase();
    const a = openStore({ baseDir: base, projectRoot: "/proj/aaa" });
    const b = openStore({ baseDir: base, projectRoot: "/proj/bbb" });
    a.put(input("fact belonging to A"));
    expect(a.list()).toHaveLength(1);
    expect(b.list()).toHaveLength(0);
  });
});
