/**
 * M6 adversarial correctness gate (free, no model calls).
 *
 * Proves Knowstone's primary claim directly against the real engine: a finding
 * whose cone changes mid-session is withheld, and a stale serve NEVER happens.
 * This is the benchmark's non-negotiable result — 0 stale serves — and it runs in
 * CI on every push. See benchmarks/adversarial.ts.
 */

import { describe, it, expect } from "vitest";
import { runAll, runScenario, SCENARIOS } from "../benchmarks/adversarial.ts";

describe("adversarial stale-file benchmark", () => {
  const results = runAll();

  it("has at least one direct, one transitive and a control scenario", () => {
    const types = new Set(SCENARIOS.map((s) => s.projectType));
    expect(types.has("ts-direct")).toBe(true);
    expect(types.has("ts-transitive")).toBe(true);
    expect(types.has("control-unrelated")).toBe(true);
  });

  it("serves ZERO stale facts across every scenario", () => {
    const staleServes = results.filter((r) => r.staleServed);
    // On failure, surface which scenario served stale so the cause is obvious.
    expect(staleServes.map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  });

  it("every scenario behaves as required", () => {
    for (const r of results) {
      expect(r.pass, `${r.id} — ${r.detail}`).toBe(true);
    }
  });

  it("withholds the finding after a DIRECT in-cone edit", () => {
    const r = runScenario(SCENARIOS.find((s) => s.id === "ts-direct-edit")!);
    expect(r.served).toBe("WITHHELD");
    expect(r.staleServed).toBe(false);
  });

  it("withholds after a TRANSITIVE edit (per-file binding would miss this)", () => {
    const r = runScenario(SCENARIOS.find((s) => s.id === "ts-transitive-edit")!);
    expect(r.served).toBe("WITHHELD");
  });

  it("withholds for a PHP relative include too", () => {
    const r = runScenario(SCENARIOS.find((s) => s.id === "php-require-edit")!);
    expect(r.served).toBe("WITHHELD");
  });

  it("does NOT over-withhold: an unrelated edit leaves the fact FRESH", () => {
    const r = runScenario(SCENARIOS.find((s) => s.id === "control-unrelated-edit")!);
    expect(r.served).toBe("FRESH");
    expect(r.staleServed).toBe(false);
  });
});
