/**
 * Knowstone benchmark — caching-aware cost maths and summary statistics.
 *
 * This module is pure and unit-tested. It turns the four raw token axes into a
 * single, model-agnostic "effective token" figure using the multipliers Anthropic
 * documents for prompt caching, and computes the medians and inter-quartile ranges
 * the report uses. See ../../../research/04-caching-and-token-strategy.md (§2.1):
 *   - a cache READ bills at ~0.1x an input token (lower on some models),
 *   - a cache WRITE at 1.25x (5-min TTL) or 2x (1-hour TTL),
 *   - OUTPUT tokens at ~5x an input token.
 *
 * We report in "input-token-equivalents" rather than dollars so the figure does
 * not depend on a price list we would have to keep current. The CLI's own
 * `total_cost_usd` is recorded separately as a cross-check, never as the headline.
 */

import type { Usage } from "./types.ts";

/**
 * The multipliers that convert each axis to input-token-equivalents. Defaults
 * follow the documented ratios; cacheWrite defaults to the 5-minute (1.25x) rate.
 * On a Max subscription the cache TTL is 1 hour (2x), so the runner can override
 * cacheWrite to 2. cacheRead defaults to the conservative 0.1x (some models are
 * cheaper at 0.05x, which would only widen Knowstone's measured gap or narrow it;
 * we take the figure that is least favourable to a "we saved tokens" claim).
 */
export interface CostModel {
  /** Output token weight relative to an input token. */
  output: number;
  /** Cache-read weight relative to an input token. */
  cacheRead: number;
  /** Cache-write weight relative to an input token. */
  cacheWrite: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

/**
 * Effective input-token-equivalents for one session. Fresh input tokens count
 * once; cache reads and writes and output tokens are weighted. This is the single
 * number that reflects what a session "really costs" once caching is accounted
 * for, which is the whole point of the honest token model in research/04.
 */
export function effectiveTokens(usage: Usage, model: CostModel = DEFAULT_COST_MODEL): number {
  return (
    usage.inputTokens +
    usage.cacheCreationInputTokens * model.cacheWrite +
    usage.cacheReadInputTokens * model.cacheRead +
    usage.outputTokens * model.output
  );
}

/** Total raw tokens moved (all four axes summed), for a size-of-session sense check. */
export function rawTokens(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}

/**
 * The p-th quantile (0..1) of a sample, by linear interpolation between the two
 * nearest ranks (the "R-7"/Excel method). Throws on an empty sample so a missing
 * measurement is never silently reported as zero.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("quantile of an empty sample");
  if (p < 0 || p > 1) throw new Error(`quantile p out of range: ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo] as number;
  const hiVal = sorted[hi] as number;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (rank - lo);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Inter-quartile range: Q3 − Q1. The report pairs every median with this spread. */
export function iqr(values: number[]): number {
  return quantile(values, 0.75) - quantile(values, 0.25);
}

/** A median with its IQR and sample size: the shape every reported figure takes. */
export interface Summary {
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  n: number;
}

export function summarise(values: number[]): Summary {
  return {
    median: median(values),
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    iqr: iqr(values),
    n: values.length,
  };
}
