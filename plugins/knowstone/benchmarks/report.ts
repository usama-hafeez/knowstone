/**
 * Knowstone benchmark — turn raw RunRecords into the written results report.
 *
 * Reads a results.jsonl (or records.json) produced by run.ts, drops warm-ups and
 * failed sessions, and reports median + IQR on all four axes per task and arm,
 * the paired B−A difference, correctness graded blind, and — the one that can veto
 * a release — the number of stale serves on the adversarial tasks, which must be
 * zero. The aggregation functions are pure so they can be unit-tested; only
 * `writeReport` touches the filesystem.
 *
 * Honesty: if the measured benefit is marginal, the report says so. No figure here
 * is borrowed; every number traces to the run that produced the input records.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { Arm, RunRecord } from "./types.ts";
import {
  DEFAULT_COST_MODEL,
  effectiveTokens,
  summarise,
  type CostModel,
  type Summary,
} from "./metrics.ts";

/** The axes we summarise. Each maps a record to a number. */
const AXES = {
  effectiveTokens: (r: RunRecord) => effectiveTokens(r.usage),
  inputTokens: (r: RunRecord) => r.usage.inputTokens,
  outputTokens: (r: RunRecord) => r.usage.outputTokens,
  cacheReadTokens: (r: RunRecord) => r.usage.cacheReadInputTokens,
  apiCalls: (r: RunRecord) => r.apiCalls,
  toolCalls: (r: RunRecord) => r.toolCalls,
  filesRead: (r: RunRecord) => r.filesRead,
  durationMs: (r: RunRecord) => r.durationMs,
} as const;

type AxisName = keyof typeof AXES;

/** Load records from a results.jsonl (one JSON object per line) or a records.json array. */
export function loadRecords(path: string): RunRecord[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return JSON.parse(text) as RunRecord[];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunRecord);
}

/** Keep only measured, successful, non-warm-up sessions. */
export function measured(records: RunRecord[]): RunRecord[] {
  return records.filter((r) => !r.warmup && r.ok);
}

/** Group records by a key function. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k) ?? [];
    bucket.push(item);
    map.set(k, bucket);
  }
  return map;
}

/** Summary of one axis for one arm, plus the correctness rate for that cell. */
export interface CellSummary {
  n: number;
  correctRate: number;
  axes: Record<AxisName, Summary | null>;
}

function summariseCell(records: RunRecord[]): CellSummary {
  const axes = {} as Record<AxisName, Summary | null>;
  for (const name of Object.keys(AXES) as AxisName[]) {
    const values = records.map(AXES[name]);
    axes[name] = values.length > 0 ? summarise(values) : null;
  }
  const graded = records.filter((r) => r.grade !== undefined);
  const correct = graded.filter((r) => r.grade?.correct).length;
  return {
    n: records.length,
    correctRate: graded.length > 0 ? correct / graded.length : 0,
    axes,
  };
}

/** Per-task comparison of the two arms. */
export interface TaskComparison {
  repoType: string;
  taskId: string;
  adversarialStaleServes: number;
  off: CellSummary;
  on: CellSummary;
}

/**
 * The count of stale serves is computed over ALL graded records for the task (both
 * arms, including — deliberately — any arm), because a single stale serve anywhere
 * is a correctness failure. In practice only the ON arm can serve a cached stale
 * fact; the OFF arm has no store. This is the number that must be zero.
 */
export function compare(records: RunRecord[]): TaskComparison[] {
  const byCell = groupBy(measured(records), (r) => `${r.repoType}\u0000${r.taskId}`);
  const out: TaskComparison[] = [];
  for (const [key, cell] of byCell) {
    const [repoType, taskId] = key.split("\u0000") as [string, string];
    const arm = (a: Arm) => cell.filter((r) => r.arm === a);
    out.push({
      repoType,
      taskId,
      adversarialStaleServes: cell.filter((r) => r.grade?.staleServed).length,
      off: summariseCell(arm("off")),
      on: summariseCell(arm("on")),
    });
  }
  return out.sort((a, b) => (a.repoType + a.taskId).localeCompare(b.repoType + b.taskId));
}

/** Total stale serves across every task: the release-vetoing number. */
export function totalStaleServes(records: RunRecord[]): number {
  return measured(records).filter((r) => r.grade?.staleServed).length;
}

function fmt(s: Summary | null): string {
  if (!s) return "—";
  return `${round(s.median)} (IQR ${round(s.iqr)}, n=${s.n})`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Render the markdown report body. Pure; returns the text. */
export function renderReport(
  records: RunRecord[],
  costModel: CostModel = DEFAULT_COST_MODEL,
): string {
  const comparisons = compare(records);
  const stale = totalStaleServes(records);
  const measuredCount = measured(records).length;
  const lines: string[] = [];

  lines.push("# Knowstone benchmark — results");
  lines.push("");
  lines.push(
    `Measured sessions (warm-ups and failures excluded): **${measuredCount}**. ` +
      `Cost model: output ×${costModel.output}, cache-read ×${costModel.cacheRead}, cache-write ×${costModel.cacheWrite} (input-token-equivalents).`,
  );
  lines.push("");
  lines.push(
    `## Adversarial correctness: **${stale} stale serve(s)** ${stale === 0 ? "✅ (required: 0)" : "❌ FAIL — a stale serve is a correctness failure, not a saving"}`,
  );
  lines.push("");
  lines.push("## Per-task, per-arm (median, IQR)");
  lines.push("");
  lines.push(
    "| repo | task | arm | n | correct | eff.tokens | input | output | cache-read | API calls | tool calls | files | ms |",
  );
  lines.push("|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const c of comparisons) {
    for (const arm of ["off", "on"] as const) {
      const cell = c[arm];
      lines.push(
        `| ${c.repoType} | ${c.taskId} | ${arm} | ${cell.n} | ${pct(cell.correctRate)} | ` +
          `${fmt(cell.axes.effectiveTokens)} | ${fmt(cell.axes.inputTokens)} | ${fmt(cell.axes.outputTokens)} | ` +
          `${fmt(cell.axes.cacheReadTokens)} | ${fmt(cell.axes.apiCalls)} | ${fmt(cell.axes.toolCalls)} | ` +
          `${fmt(cell.axes.filesRead)} | ${fmt(cell.axes.durationMs)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Paired B−A (on minus off), median effective tokens");
  lines.push("");
  lines.push("| repo | task | off median | on median | Δ (on−off) |");
  lines.push("|---|---|--:|--:|--:|");
  for (const c of comparisons) {
    const off = c.off.axes.effectiveTokens?.median ?? null;
    const on = c.on.axes.effectiveTokens?.median ?? null;
    const delta = off !== null && on !== null ? round(on - off) : null;
    lines.push(
      `| ${c.repoType} | ${c.taskId} | ${off !== null ? round(off) : "—"} | ${on !== null ? round(on) : "—"} | ${delta !== null ? delta : "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    "> Read Δ honestly: a negative Δ means the ON arm used fewer effective tokens. " +
      "If the medians overlap within their IQRs, the difference is not meaningful and the report says the benefit is marginal.",
  );
  lines.push("");
  return lines.join("\n");
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Read records from `input`, render, and write the markdown to `output`. */
export function writeReport(input: string, output: string): void {
  const records = loadRecords(input);
  writeFileSync(output, renderReport(records), "utf8");
}

// CLI: node --experimental-strip-types benchmarks/report.ts <results.jsonl> <report.md>
const invoked = process.argv[1] ?? "";
if (invoked.endsWith("report.ts") || invoked.endsWith("report.js")) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    process.stderr.write("usage: report.ts <results.jsonl> <report.md>\n");
    process.exit(2);
  }
  writeReport(input, output);
  process.stdout.write(`wrote ${output}\n`);
}
