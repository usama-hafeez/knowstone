# Knowstone benchmark

An honest, re-runnable measurement of what the Knowstone plugin changes about a
Claude Code session — on real repositories, with correctness graded, and with a
hard rule that **serving a stale fact counts as a correctness failure, not a
saving**. It implements the protocol in
[`research/05-product-architecture-security-benchmark.md`](../../../research/05-product-architecture-security-benchmark.md)
§5.6 and the honest token model in
[`research/04-caching-and-token-strategy.md`](../../../research/04-caching-and-token-strategy.md)
§2.

There are **two harnesses**, because the two claims are different:

1. **Correctness harness (free, no model calls).** Drives the real engine: record
   a finding, edit a file in its dependency cone, then recall — and assert the
   fact is **withheld**. A stale serve fails the test. This proves the primary
   claim (freshness you can trust) at zero cost and runs in CI. See
   `test/adversarial-benchmark.test.ts`.
2. **Token-efficiency A/B harness (paid — uses your Max subscription usage).**
   Real `claude -p` sessions, plugin on vs off, metrics read from the model API
   `usage` object. This measures the secondary claim (fewer round-trips / less
   re-exploration). It is the code in this folder.

## What it measures

Per session, read from the CLI's `stream-json` output:

- the four token axes kept **separate** (`input`, `output`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`) — never summed,
  because they bill very differently;
- a caching-aware **effective-token** figure (output ×5, cache-read ×0.1,
  cache-write ×1.25), in input-token-equivalents (see `metrics.ts`);
- **API round-trips** (distinct assistant message ids), **tool calls**, **distinct
  files read**, **wall-clock**, the CLI's own cost estimate, and **correctness**
  (graded blind by a pure predicate over the answer text).

The report gives median + IQR per task and arm, the paired B−A difference, and the
total stale serves (which must be 0). If the medians overlap within their IQRs, it
says the benefit is marginal — plainly.

## How the harness drives Claude Code (verified contract)

- Headless: `claude -p "<prompt>" --output-format stream-json --verbose`. The first
  `system`/`init` event lists loaded plugins, so each run **proves** whether it was
  the on or off arm — we never trust the flag alone.
- On arm loads the plugin with `--plugin-dir <abs>/plugins/knowstone` (no global
  install, no marketplace mutation). Off arm omits it.
- Model and effort pinned with `--model` / `--effort` (and `CLAUDE_CODE_EFFORT_LEVEL`,
  which takes precedence). Tools held constant with `--tools`. `--permission-mode
dontAsk` and `--no-session-persistence` keep headless runs unattended and clean.
- Runs inherit your real config dir, because a **fresh `CLAUDE_CONFIG_DIR` is not
  logged in** (verified: it returns "Not logged in"). So the arm is isolated by
  `--plugin-dir` (session-only, no install, no marketplace mutation) plus
  `--no-session-persistence`, not by a throwaway config dir. Your other enabled
  plugins and global CLAUDE.md therefore load in **both** arms — constant across
  them, which is what the protocol requires. **No `ANTHROPIC_API_KEY` is ever set
  and `--bare` is never used**, so runs use your subscription login (Max usage),
  not metered API billing. Only `CLAUDE_PLUGIN_DATA` is overridden per run, to hold
  the on arm's seeded store.

## Determinism and isolation

- Every repo is materialised into a throwaway scratch dir at a **pinned revision**
  (`git archive <ref>` for a local repo, `clone` + `checkout <ref>` for a remote).
  Your real working trees are read-only and untouched.
- Fixed task order, fixed prompts, fixed answer keys, fixed cost model.
- Interleaved A,B,A,B (not blocked); the starting arm alternates per task for cache
  fairness; one warm-up per arm is discarded.

## Running it

Build the plugin first (the on arm seeds findings via the built CLI):

```
npm run build
```

Calibration (tiny — a few sessions, so real per-session usage can be measured
before any large run):

```
npm run bench -- --mode calibrate
```

Full run (only after reviewing the calibration usage):

```
npm run bench -- --mode full --reps 5 --repos small-ts-knowstone,<legacy-php-id>,<mid-ts-id>
```

Then render the report:

```
npm run bench:report -- benchmarks/runs/<runId>/results.jsonl benchmarks/runs/<runId>/report.md
```

Run output lands in `benchmarks/runs/<runId>/` (git-ignored, machine-specific); the
curated written report is committed separately as `benchmarks/RESULTS.md`.

Guardrails: `--max-sessions` caps total sessions (default 8 outside `full`);
`--max-turns` and `--timeout-ms` bound each session; `--mode dry` schedules and
grades nothing, just prints the plan.

## Answer keys

The per-repo answer keys live in `repos.ts` and are committed, so grading is
auditable. Only fully-worked, verified plans are registered; asking the runner for
a repo without a plan is an explicit error, never a guessed key. The `small-ts`
plan (Knowstone's own source) is fully worked here because its answers can be
checked against this repository. The legacy-PHP (the ERP) and mid-TS plans are
finalised in the run phase, after reading those repos.

## Known unknowns to confirm during calibration

These are documented rather than assumed; calibration settles them before any
large run:

1. **Exact top-level keys of the result event** — confirm `usage`,
   `total_cost_usd`, `num_turns` names on this CLI version by reading one run's raw
   `stream-json`.
2. **Whether Claude Code honours a pre-set `CLAUDE_PLUGIN_DATA`** — the on arm
   seeds findings into that dir and the model's `recall` must read the same dir. If
   the runtime overrides it, the seed path is adjusted to match.
3. **Default effort for `-p` runs** — pinned explicitly via `--effort` and the env
   var, so it does not matter, but worth eyeballing once.
4. **Subscription auth under a fresh `CLAUDE_CONFIG_DIR`** — RESOLVED: a fresh
   config dir is NOT logged in ("Not logged in · Please run /login"), so runs
   inherit the real config dir and isolate the arm via `--plugin-dir` instead.
