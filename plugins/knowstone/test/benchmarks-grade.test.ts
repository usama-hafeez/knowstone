import { describe, it, expect } from "vitest";
import {
  normalise,
  containsAll,
  containsAny,
  containsWord,
  gradeAdversarial,
} from "../benchmarks/grade.ts";

describe("text helpers", () => {
  it("normalise lower-cases and collapses whitespace", () => {
    expect(normalise("  Foo   BAR\n baz ")).toBe("foo bar baz");
  });

  it("containsAll requires every needle", () => {
    expect(containsAll("the quick brown fox", ["quick", "fox"])).toBe(true);
    expect(containsAll("the quick brown fox", ["quick", "cat"])).toBe(false);
  });

  it("containsAny requires at least one", () => {
    expect(containsAny("alpha beta", ["gamma", "beta"])).toBe(true);
    expect(containsAny("alpha beta", ["gamma", "delta"])).toBe(false);
  });

  it("containsWord respects token boundaries", () => {
    expect(containsWord("run vitest now", "vitest")).toBe(true);
    expect(containsWord("vitestrunner", "vitest")).toBe(false);
  });
});

describe("gradeAdversarial", () => {
  const fresh = "9.9.9-bench";
  const stale = "0.1.0";

  it("flags a stale serve when only the stale value is present", () => {
    const g = gradeAdversarial("The version is 0.1.0.", fresh, stale);
    expect(g.staleServed).toBe(true);
    expect(g.correct).toBe(false);
  });

  it("catches a stale value even when embedded (v0.1.0)", () => {
    const g = gradeAdversarial("It reports v0.1.0", fresh, stale);
    expect(g.staleServed).toBe(true);
  });

  it("marks correct when only the fresh value is present", () => {
    const g = gradeAdversarial("Currently 9.9.9-bench", fresh, stale);
    expect(g.correct).toBe(true);
    expect(g.staleServed).toBe(false);
  });

  it("does not score a clean stale serve when both values appear (ambiguous)", () => {
    const g = gradeAdversarial("Now 9.9.9-bench (was 0.1.0)", fresh, stale);
    expect(g.staleServed).toBe(false);
    expect(g.correct).toBe(false);
    expect(g.note).toMatch(/both/);
  });

  it("treats a declined answer as neither correct nor stale", () => {
    const g = gradeAdversarial("I cannot confirm from the current code.", fresh, stale);
    expect(g.correct).toBe(false);
    expect(g.staleServed).toBe(false);
  });
});
