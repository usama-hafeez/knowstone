/**
 * Knowstone benchmark — the orchestrator (the paid path).
 *
 * Runs the fixed battery through the real Claude Code CLI, interleaved A/B, for a
 * number of reps, and writes one graded RunRecord per session to results.jsonl.
 * It is deterministic (fixed order, pinned repo revisions, fixed prompts and
 * answer keys) and re-runnable. It NEVER runs the full battery unless explicitly
 * asked: the default mode is a tiny calibration so cost can be measured before any
 * large spend. See ./README.md for the protocol and the guardrails.
 *
 * Run from source, no build step:
 *   node --experimental-strip-types benchmarks/run.ts --mode calibrate
 *
 * Billing note: this uses the user's subscription login (no API key is set and
 * --bare is never used), so it consumes Max usage, not metered dollars. The
 * dollar figures in the records are the CLI's own client-side estimate.
 */

import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Arm, RunRecord } from "./types.ts";
import { TASKS, planTask, type PlannedTask, type PlanEntry } from "./tasks.ts";
import { planFor, type RepoPlan } from "./repos.ts";
import { runSession } from "./harness.ts";

/** Parsed CLI options for a benchmark run. */
interface Options {
  mode: "calibrate" | "full" | "dry";
  reps: number;
  repos: string[];
  model: string;
  effort: string;
  tools: string;
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  maxSessions: number;
  outDir: string;
}

function parseFlags(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else flags.set(a.slice(2), "true");
      }
    }
  }
  const mode = (flags.get("mode") ?? "calibrate") as Options["mode"];
  return {
    mode,
    reps: Number(flags.get("reps") ?? (mode === "calibrate" ? 1 : 5)),
    repos: (flags.get("repos") ?? "small-ts-knowstone").split(",").map((s) => s.trim()),
    model: flags.get("model") ?? "sonnet",
    effort: flags.get("effort") ?? "medium",
    tools: flags.get("tools") ?? "Read,Grep,Glob,Bash",
    permissionMode: flags.get("permission-mode") ?? "dontAsk",
    maxTurns: Number(flags.get("max-turns") ?? 40),
    timeoutMs: Number(flags.get("timeout-ms") ?? 300_000),
    maxSessions: Number(flags.get("max-sessions") ?? (mode === "full" ? 1000 : 8)),
    outDir: flags.get("out") ?? join(process.cwd(), "benchmarks", "runs"),
  };
}

/** One scheduled session before it is run. */
interface Scheduled {
  task: PlannedTask;
  arm: Arm;
  rep: number;
  warmup: boolean;
}

/**
 * Build the interleaved A,B,A,B order for one repo plan. For each applicable task
 * we emit one warm-up per arm (discarded) then `reps` interleaved pairs. The arm
 * that starts alternates per task so neither arm is always first (cache fairness).
 */
export function schedule(plan: RepoPlan, reps: number): Scheduled[] {
  const out: Scheduled[] = [];
  const byId = new Map(plan.entries.map((e) => [e.taskId, e]));
  let taskIndex = 0;
  for (const template of TASKS) {
    const entry = byId.get(template.id);
    if (!entry) continue; // task not planned for this repo
    const task = planTask(template, entry);
    const firstOn = taskIndex % 2 === 1;
    const arms: Arm[] = firstOn ? ["on", "off"] : ["off", "on"];
    for (const arm of arms) out.push({ task, arm, rep: -1, warmup: true });
    for (let r = 0; r < reps; r++) {
      for (const arm of arms) out.push({ task, arm, rep: r, warmup: false });
    }
    taskIndex++;
  }
  return out;
}

/** Absolute path to the plugin root (plugins/knowstone) from this file. */
function pluginRoot(): string {
  const here = new URL(".", import.meta.url).pathname;
  const normalised = /^\/[A-Za-z]:\//.test(here) ? here.slice(1) : here;
  return resolve(normalised, "..");
}

/** Ensure the plugin is built so the ON arm can seed findings via the CLI. */
function ensureBuilt(root: string): string {
  const cli = join(root, "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(
      `plugin not built: ${cli} is missing. Run "npm run build" in plugins/knowstone first.`,
    );
  }
  return cli;
}

/** Seed one Tier-B finding into the ON arm's store, bound at the pre-edit state. */
function seedFinding(cli: string, rundir: string, pluginData: string, entry: PlanEntry): void {
  if (!entry.seed) return;
  execFileSync("node", [cli, "map", "--project", rundir, "--data", pluginData], { stdio: "pipe" });
  execFileSync(
    "node",
    [
      cli,
      "note",
      "--project",
      rundir,
      "--data",
      pluginData,
      "--statement",
      entry.seed.statement,
      "--evidence",
      entry.seed.evidence.join(","),
    ],
    { stdio: "pipe" },
  );
}

/** Apply the adversarial mid-session edit to the working copy. */
function applyEdit(rundir: string, entry: PlanEntry): void {
  if (!entry.edit) return;
  const target = join(rundir, entry.edit.file);
  const before = readFileSync(target, "utf8");
  if (!before.includes(entry.edit.from)) {
    throw new Error(`adversarial edit anchor not found in ${entry.edit.file}: ${entry.edit.from}`);
  }
  writeFileSync(target, before.replace(entry.edit.from, entry.edit.to), "utf8");
}

/** Run the whole benchmark for the given options. Returns the output directory. */
export async function main(opts: Options): Promise<string> {
  const root = pluginRoot();
  const cli = ensureBuilt(root);
  const pluginDir = root; // --plugin-dir points at the plugin folder itself
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(opts.outDir, runId);
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, "results.jsonl");
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const scratch = join(tmpdir(), "kn-bench", runId);
  mkdirSync(scratch, { recursive: true });

  writeFileSync(
    join(outDir, "config.json"),
    JSON.stringify({ ...opts, runId, startedAt: Date.now() }, null, 2),
    "utf8",
  );

  let sessionsRun = 0;
  const records: RunRecord[] = [];

  for (const repoId of opts.repos) {
    const plan = planFor(repoId);
    // Materialise one pristine template per repo; copy it per session.
    const template = join(scratch, `${repoId}-template`);
    rmSync(template, { recursive: true, force: true });
    plan.config.materialise(template);

    for (const item of schedule(plan, opts.reps)) {
      if (sessionsRun >= opts.maxSessions) {
        log(`reached max-sessions cap (${opts.maxSessions}); stopping.`);
        break;
      }
      const record = await runOne(opts, {
        plan,
        item,
        template,
        scratch,
        rawDir,
        cli,
        pluginDir,
        sessionsRun,
      });
      records.push(record);
      appendFileSync(resultsPath, JSON.stringify(record) + "\n", "utf8");
      sessionsRun++;
      logRecord(record);
    }
  }

  writeFileSync(join(outDir, "records.json"), JSON.stringify(records, null, 2), "utf8");
  log(`done: ${sessionsRun} sessions. Results in ${outDir}`);
  return outDir;
}

interface RunOneCtx {
  plan: RepoPlan;
  item: Scheduled;
  template: string;
  scratch: string;
  rawDir: string;
  cli: string;
  pluginDir: string;
  sessionsRun: number;
}

/** Prepare dirs, seed/edit as needed, run and grade one session. */
async function runOne(opts: Options, ctx: RunOneCtx): Promise<RunRecord> {
  const { plan, item, template, scratch, cli, pluginDir } = ctx;
  const tag = `${item.task.id}-${item.arm}-${item.warmup ? "warm" : `r${item.rep}`}-${ctx.sessionsRun}`;
  const rundir = join(scratch, "run", tag);
  const configDir = join(scratch, "config", tag);
  const pluginData = join(scratch, "data", tag);
  rmSync(rundir, { recursive: true, force: true });
  cpSync(template, rundir, { recursive: true });

  const entry = item.task.entry;
  const base: RunRecord = {
    repo: plan.config.id,
    repoType: plan.config.type,
    taskId: item.task.id,
    arm: item.arm,
    rep: item.rep,
    warmup: item.warmup,
    pluginLoaded: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    totalCostUsd: null,
    numTurns: 0,
    apiCalls: 0,
    toolCalls: 0,
    filesRead: 0,
    durationMs: 0,
    answer: "",
    ok: false,
  };

  if (opts.mode === "dry") {
    return { ...base, ok: true, answer: "[dry run: not executed]" };
  }

  try {
    // ON arm: seed the finding at the pre-edit state, so its binding captures the
    // original hash. Then apply the adversarial edit (if any) so the recorded fact
    // is stale at query time. OFF arm gets the same edited code but no seed.
    if (item.arm === "on") seedFinding(cli, rundir, pluginData, entry);
    applyEdit(rundir, entry);

    const result = await runSession({
      cwd: rundir,
      prompt: item.task.prompt,
      model: opts.model,
      effort: opts.effort,
      arm: item.arm,
      pluginDir,
      configDir,
      pluginData,
      tools: opts.tools,
      permissionMode: opts.permissionMode,
      maxTurns: opts.maxTurns,
      timeoutMs: opts.timeoutMs,
      rawLogPath: join(ctx.rawDir, `${tag}.jsonl`),
    });

    const grade = item.task.grade(result.answer);
    return { ...base, ...result, grade };
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message.slice(0, 300) };
  } finally {
    // Clean the biggest per-session dirs to keep scratch bounded; keep raw logs.
    rmSync(rundir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

function log(msg: string): void {
  process.stdout.write(`[bench] ${msg}\n`);
}

function logRecord(r: RunRecord): void {
  const g = r.grade
    ? `${r.grade.correct ? "correct" : "WRONG"}${r.grade.staleServed ? " STALE-SERVE" : ""}`
    : "ungraded";
  const warm = r.warmup ? " (warmup)" : "";
  log(
    `${r.taskId} ${r.arm}${warm}: ${r.ok ? "ok" : `FAIL(${r.error})`} plugin=${r.pluginLoaded} ` +
      `in=${r.usage.inputTokens} out=${r.usage.outputTokens} cacheR=${r.usage.cacheReadInputTokens} ` +
      `calls=${r.apiCalls} tools=${r.toolCalls} ${g}`,
  );
}

// Entry point.
const invoked = process.argv[1] ?? "";
if (invoked.endsWith("run.ts") || invoked.endsWith("run.js")) {
  const opts = parseFlags(process.argv.slice(2));
  if (opts.mode === "full") {
    log("MODE=full: this runs the whole paid battery. Ensure you intend the usage spend.");
  }
  main(opts).catch((err) => {
    process.stderr.write(`[bench] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
