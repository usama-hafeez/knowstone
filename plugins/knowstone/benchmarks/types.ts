/**
 * Knowstone benchmark — shared types for the A/B token harness.
 *
 * The harness runs a fixed battery of realistic tasks through the real Claude
 * Code CLI (headless, `claude -p`) twice: once with the Knowstone plugin loaded
 * (arm "B", the on arm) and once without it (arm "A", the baseline). It records,
 * per run, the token usage reported by the model API `usage` object plus derived
 * counts, so the report can compare the two arms honestly. See ./README.md and
 * ../../../research/05-product-architecture-security-benchmark.md (§5.6).
 *
 * Nothing in this file touches the plugin's own source: the harness only spawns
 * the CLI and parses its JSON, so it can be run from source with
 * `node --experimental-strip-types` without a build step.
 */

/** The two benchmark arms. "off" = baseline (no plugin); "on" = Knowstone loaded. */
export type Arm = "off" | "on";

/** The project types we benchmark across (research/05 §5.6 "Project types"). */
export type RepoType = "small-ts" | "legacy-php" | "mid-ts" | "large" | "node-ts";

/**
 * Token usage for one session, taken verbatim from the CLI result message's
 * `usage` object. The four axes are kept separate (never summed) because they
 * bill very differently: a cache read is ~0.1x an input token, output ~5x.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** One graded, measured session: the atom the report is built from. */
export interface RunRecord {
  /** Repo this ran against. */
  repo: string;
  repoType: RepoType;
  /** Task id from the battery. */
  taskId: string;
  arm: Arm;
  /** 0-based repetition index (reps beyond the warm-up). */
  rep: number;
  /** True for the discarded warm-up run of each (repo, task, arm). */
  warmup: boolean;
  /** Whether the CLI reported the plugin as loaded (from system/init). Proves the arm. */
  pluginLoaded: boolean;
  /** Raw usage from the API. */
  usage: Usage;
  /** The CLI's own client-side cost estimate (USD); a cross-check, not a bill. */
  totalCostUsd: number | null;
  /** Number of agent turns the CLI reported. */
  numTurns: number;
  /** Distinct assistant message ids = API round-trips (parallel tool calls share an id). */
  apiCalls: number;
  /** Total tool invocations across the session. */
  toolCalls: number;
  /** Distinct files opened via the Read tool. */
  filesRead: number;
  /** Wall-clock for the session, milliseconds. */
  durationMs: number;
  /** The final answer text, stored so correctness can be graded (blind) from it. */
  answer: string;
  /** Grading verdict, filled in after the run. */
  grade?: Grade;
  /** CLI exit was clean and a result message was parsed. */
  ok: boolean;
  /** When something went wrong, a short reason (never the repo's contents). */
  error?: string;
}

/**
 * A task's grading verdict. `correct` is the headline. `staleServed` is the
 * mandatory correctness trap for adversarial tasks: true means the session acted
 * on a value that a mid-session edit had already invalidated. A stale serve is a
 * correctness FAILURE, never a saving.
 */
export interface Grade {
  correct: boolean;
  /** Only meaningful for adversarial tasks; true = served an out-of-date value. */
  staleServed: boolean;
  /** Short human-readable note on why it was graded this way. */
  note: string;
}

/**
 * A benchmark task TEMPLATE. Grading is NOT attached here: it is derived from the
 * task kind (keyword for normal tasks, fresh-vs-stale for adversarial ones) and
 * the per-repo answer key, by `bindGrade` in ./tasks.ts. A grader is a pure
 * predicate over the answer text, so it is blind by construction — it never sees
 * which arm produced the answer.
 */
export interface Task {
  id: string;
  /** Which repo types this task is meaningful for. */
  appliesTo: RepoType[];
  /** The user prompt handed to `claude -p` (may contain a ${target} placeholder). */
  prompt: string;
  /** Short description of what a correct answer must contain (for the report). */
  expected: string;
  /** True for the mandatory stale-file adversarial tasks. */
  adversarial: boolean;
}
