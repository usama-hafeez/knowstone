import { describe, it, expect } from "vitest";
import { measured, compare, totalStaleServes, renderReport } from "../benchmarks/report.ts";
import type { RunRecord } from "../benchmarks/types.ts";

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    repo: "small-ts-knowstone",
    repoType: "small-ts",
    taskId: "t9-adversarial-direct",
    arm: "on",
    rep: 0,
    warmup: false,
    pluginLoaded: true,
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 500,
    },
    totalCostUsd: 0.01,
    numTurns: 3,
    apiCalls: 3,
    toolCalls: 2,
    filesRead: 1,
    durationMs: 1000,
    answer: "9.9.9-bench",
    ok: true,
    grade: { correct: true, staleServed: false, note: "" },
    ...overrides,
  };
}

describe("report aggregation", () => {
  it("measured() drops warm-ups and failed sessions", () => {
    const recs = [record({}), record({ warmup: true }), record({ ok: false })];
    expect(measured(recs).length).toBe(1);
  });

  it("totalStaleServes counts every stale serve across arms", () => {
    const recs = [
      record({}),
      record({ grade: { correct: false, staleServed: true, note: "stale" } }),
      record({ warmup: true, grade: { correct: false, staleServed: true, note: "stale" } }), // warm-up excluded
    ];
    expect(totalStaleServes(recs)).toBe(1);
  });

  it("compare groups by repo+task and splits arms", () => {
    const recs = [record({ arm: "on" }), record({ arm: "off" }), record({ arm: "off" })];
    const cmp = compare(recs);
    expect(cmp.length).toBe(1);
    expect(cmp[0]!.on.n).toBe(1);
    expect(cmp[0]!.off.n).toBe(2);
  });

  it("renderReport headlines 0 stale serves with a tick, and a non-zero as FAIL", () => {
    const clean = renderReport([record({})]);
    expect(clean).toMatch(/0 stale serve/);
    expect(clean).toContain("✅");

    const dirty = renderReport([
      record({ grade: { correct: false, staleServed: true, note: "stale" } }),
    ]);
    expect(dirty).toMatch(/1 stale serve/);
    expect(dirty).toContain("FAIL");
  });
});
