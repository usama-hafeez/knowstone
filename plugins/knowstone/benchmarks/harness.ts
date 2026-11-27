/**
 * Knowstone benchmark — one measured headless session.
 *
 * Runs a single `claude -p` session non-interactively and parses its
 * `stream-json` output into the measurements the report needs. The design follows
 * the verified CLI contract (see ./README.md "How the harness drives Claude Code"):
 *   - `--output-format stream-json --verbose` emits one JSON event per line;
 *   - the first `system`/`init` event lists loaded plugins, which PROVES whether
 *     this run was the on arm or the off arm (we never trust the flag alone);
 *   - the final `result` event carries the `usage` object (the four token axes,
 *     kept separate), `total_cost_usd`, `num_turns` and the answer text;
 *   - API round-trips = distinct assistant message ids (parallel tool calls share
 *     one id), per the cost-tracking docs.
 *
 * Isolation and honesty guarantees enforced here:
 *   - every run gets its own CLAUDE_CONFIG_DIR, so the user's real ~/.claude is
 *     never read or written;
 *   - we never set ANTHROPIC_API_KEY and never pass --bare, so the run uses the
 *     user's subscription login, not metered API billing;
 *   - the on arm loads the plugin ONLY via --plugin-dir (no global install, no
 *     marketplace mutation); the off arm omits it.
 */

import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import type { Arm, Usage } from "./types.ts";

/** Everything needed to run and measure one session. */
export interface SessionOptions {
  /** The executable to run (default resolves to claude/claude.exe). */
  command?: string;
  /** Working directory = the repo copy under test. */
  cwd: string;
  /** The fully-composed user prompt. */
  prompt: string;
  /** Model alias or id, pinned for every run in the battery. */
  model: string;
  /** Reasoning effort, pinned for every run. */
  effort: string;
  arm: Arm;
  /** Absolute path to plugins/knowstone, passed only for the on arm. */
  pluginDir?: string;
  /**
   * The plugin data dir the on arm's store lives in. We export CLAUDE_PLUGIN_DATA
   * as this, but note (VERIFIED) that Claude Code OVERRIDES it for an inline
   * (--plugin-dir) plugin to `<config>/plugins/data/<name>-inline`; the caller
   * therefore sets this to that exact path (see run.ts inlineDataDir) so the seed
   * and the session agree. The config dir is NOT overridden: a fresh
   * CLAUDE_CONFIG_DIR is not logged in, so the run must inherit the user's real
   * subscription login. The arm is isolated by --plugin-dir (session-only, no
   * install) and --no-session-persistence.
   */
  pluginData: string;
  /** Built-in tools to make available, comma-separated (held constant across arms). */
  tools: string;
  /**
   * Tools to AUTO-APPROVE, comma-separated. Required: without it, a headless run in
   * dontAsk mode DENIES every tool that would need approval (verified in
   * calibration: the agent could not even read a file), which would make the token
   * and exploration comparison meaningless. Held constant across arms.
   */
  allowedTools: string;
  /** Permission mode (dontAsk); auto-approval is driven by allowedTools above. */
  permissionMode: string;
  /** Safety cap on agent turns. */
  maxTurns: number;
  /** Hard wall-clock timeout in ms; the process is killed past it. */
  timeoutMs: number;
  /** Where to append this run's full raw stream-json (one object per line). */
  rawLogPath: string;
}

/** The measured result of one session (merged into a RunRecord by the caller). */
export interface SessionResult {
  pluginLoaded: boolean;
  usage: Usage;
  totalCostUsd: number | null;
  numTurns: number;
  apiCalls: number;
  toolCalls: number;
  filesRead: number;
  durationMs: number;
  answer: string;
  ok: boolean;
  error?: string;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Default executable name, with the .exe Node needs on Windows (shell:false). */
function defaultCommand(): string {
  if (process.env.KN_BENCH_CLAUDE) return process.env.KN_BENCH_CLAUDE;
  return process.platform === "win32" ? "claude.exe" : "claude";
}

/** Build the argv for one session. The on arm adds exactly one --plugin-dir. */
export function buildArgs(opts: SessionOptions): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--effort",
    opts.effort,
    "--permission-mode",
    opts.permissionMode,
    "--tools",
    opts.tools,
    "--allowedTools",
    opts.allowedTools,
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(opts.maxTurns),
  ];
  if (opts.arm === "on" && opts.pluginDir) {
    args.push("--plugin-dir", opts.pluginDir);
  }
  return args;
}

/** The subset of a result event we read. All fields are optional and defended. */
interface ResultEvent {
  type?: string;
  subtype?: string;
  usage?: Partial<Record<keyof Usage | string, unknown>>;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  result?: unknown;
  is_error?: unknown;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Pull the four usage axes out of a result event's usage object, defensively. */
function readUsage(usage: ResultEvent["usage"]): Usage {
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
    cacheReadInputTokens: num(usage.cache_read_input_tokens),
  };
}

/**
 * Accumulates counts as stream-json events arrive. Kept as a class so the line
 * parser stays a thin loop and the counting logic is testable in isolation.
 */
export class StreamAccumulator {
  pluginLoaded = false;
  private readonly assistantIds = new Set<string>();
  toolCalls = 0;
  private readonly filesRead = new Set<string>();
  usage: Usage = { ...ZERO_USAGE };
  totalCostUsd: number | null = null;
  numTurns = 0;
  answer = "";
  sawResult = false;
  resultIsError = false;

  /** Feed one parsed JSON event. Unknown shapes are ignored, never thrown on. */
  push(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "";

    if (type === "system" && e.subtype === "init") {
      this.readPlugins(e.plugins);
      return;
    }
    if (type === "assistant") {
      this.readAssistant(e.message);
      return;
    }
    if (type === "result") {
      this.readResult(e as ResultEvent);
      return;
    }
  }

  private readPlugins(plugins: unknown): void {
    if (!Array.isArray(plugins)) return;
    for (const p of plugins) {
      if (p && typeof p === "object") {
        const name = (p as { name?: unknown }).name;
        if (typeof name === "string" && name.toLowerCase() === "knowstone") {
          this.pluginLoaded = true;
        }
      }
    }
  }

  private readAssistant(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const m = message as { id?: unknown; content?: unknown };
    if (typeof m.id === "string") this.assistantIds.add(m.id);
    if (!Array.isArray(m.content)) return;
    for (const block of m.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
        this.toolCalls += 1;
        const b = block as { name?: unknown; input?: unknown };
        if (b.name === "Read" && b.input && typeof b.input === "object") {
          const fp = (b.input as { file_path?: unknown }).file_path;
          if (typeof fp === "string") this.filesRead.add(fp);
        }
      }
    }
  }

  private readResult(e: ResultEvent): void {
    this.sawResult = true;
    this.usage = readUsage(e.usage);
    this.totalCostUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : null;
    this.numTurns = num(e.num_turns);
    this.answer = typeof e.result === "string" ? e.result : "";
    this.resultIsError =
      e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success");
  }

  get apiCalls(): number {
    return this.assistantIds.size;
  }

  get filesReadCount(): number {
    return this.filesRead.size;
  }
}

/**
 * Run one session to completion and return its measurements. Never throws: a
 * spawn failure, a timeout or a non-zero exit comes back as `ok: false` with a
 * short reason, so the runner can record it and move on.
 */
export function runSession(opts: SessionOptions): Promise<SessionResult> {
  const command = opts.command ?? defaultCommand();
  const args = buildArgs(opts);
  const env = sessionEnv(opts);
  mkdirSync(opts.pluginData, { recursive: true });

  return new Promise<SessionResult>((resolve) => {
    const started = Date.now();
    const acc = new StreamAccumulator();
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, args, { cwd: opts.cwd, env, shell: false });

    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        pluginLoaded: acc.pluginLoaded,
        usage: acc.usage,
        totalCostUsd: acc.totalCostUsd,
        numTurns: acc.numTurns,
        apiCalls: acc.apiCalls,
        toolCalls: acc.toolCalls,
        filesRead: acc.filesReadCount,
        durationMs: Date.now() - started,
        answer: acc.answer,
        ok: ok && acc.sawResult && !acc.resultIsError,
        error: error ?? (acc.sawResult ? undefined : "no result event parsed"),
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `timeout after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let nl = stdoutBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        consumeLine(line, acc, opts.rawLogPath);
        nl = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    child.on("error", (err) => finish(false, `spawn error: ${err.message}`));

    child.on("close", (code) => {
      if (stdoutBuffer.trim() !== "") consumeLine(stdoutBuffer, acc, opts.rawLogPath);
      const trailing = stderr.trim();
      finish(
        code === 0,
        code === 0 ? undefined : `exit ${code}${trailing ? `: ${trailing.slice(-200)}` : ""}`,
      );
    });
  });
}

/** Parse one stream-json line, feed the accumulator, and persist the raw line. */
function consumeLine(line: string, acc: StreamAccumulator, rawLogPath: string): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  try {
    appendFileSync(rawLogPath, trimmed + "\n", "utf8");
  } catch {
    // The raw transcript is a nice-to-have for re-grading; never fail the run over it.
  }
  try {
    acc.push(JSON.parse(trimmed));
  } catch {
    // A non-JSON line (a stray log line) is ignored; the result event is what matters.
  }
}

/**
 * The environment for one run: the parent env, minus any API key so the
 * subscription login is always used, plus the per-run plugin data dir and a
 * pinned effort (the env var takes precedence over --effort). CLAUDE_CONFIG_DIR is
 * deliberately left as inherited: a fresh config dir is not logged in, so runs
 * must use the user's real login.
 */
function sessionEnv(opts: SessionOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_PLUGIN_DATA = opts.pluginData;
  env.CLAUDE_CODE_EFFORT_LEVEL = opts.effort;
  return env;
}
