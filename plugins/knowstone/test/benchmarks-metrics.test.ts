import { describe, it, expect } from "vitest";
import {
  effectiveTokens,
  rawTokens,
  quantile,
  median,
  iqr,
  summarise,
  DEFAULT_COST_MODEL,
} from "../benchmarks/metrics.ts";

describe("effectiveTokens", () => {
  it("weights each axis by the documented multipliers", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 1000,
    };
    // 100 + 200*1.25 + 1000*0.1 + 10*5 = 100 + 250 + 100 + 50 = 500
    expect(effectiveTokens(usage, DEFAULT_COST_MODEL)).toBe(500);
  });

  it("cache reads are an order of magnitude cheaper than fresh input", () => {
    const cached = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000,
    };
    const fresh = {
      inputTokens: 1000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(effectiveTokens(cached)).toBeLessThan(effectiveTokens(fresh));
    expect(effectiveTokens(cached)).toBe(100);
  });

  it("rawTokens sums all four axes", () => {
    expect(
      rawTokens({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      }),
    ).toBe(10);
  });
});

describe("quantile / median / iqr", () => {
  it("median of an even sample interpolates", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("median of an odd sample is the middle", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("single value is its own quantile", () => {
    expect(quantile([42], 0.25)).toBe(42);
    expect(median([42])).toBe(42);
  });

  it("iqr of 1..5 is Q3-Q1 = 4-2", () => {
    expect(iqr([1, 2, 3, 4, 5])).toBe(2);
  });

  it("throws on an empty sample rather than reporting zero", () => {
    expect(() => quantile([], 0.5)).toThrow();
  });

  it("rejects a p outside [0,1]", () => {
    expect(() => quantile([1, 2], 1.5)).toThrow();
  });

  it("summarise reports median, quartiles, iqr and n", () => {
    const s = summarise([1, 2, 3, 4, 5]);
    expect(s).toEqual({ median: 3, q1: 2, q3: 4, iqr: 2, n: 5 });
  });
});
