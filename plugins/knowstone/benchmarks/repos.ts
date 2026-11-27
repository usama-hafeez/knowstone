/**
 * Knowstone benchmark — the project types under test, how each is materialised
 * deterministically, and the per-repo answer keys that bind the fixed task
 * battery to concrete, checkable answers.
 *
 * Every repo is materialised into a throwaway scratch directory at a PINNED
 * revision, so a run is reproducible and the user's real working trees are never
 * touched (research/05 §5.6 "same repo @ same commit, clean tree"; the brief's
 * "treat my real repos as read-only"). We copy from git at a ref (git archive) or
 * clone at a ref — never run the model against a live, mutable working copy.
 *
 * Answer keys (the PlanEntry list per repo) are deliberately explicit and live in
 * version control, so grading is auditable. The small-ts plan is fully worked here
 * because its answers can be verified from this very repository; the legacy-php
 * (the ERP) and mid-ts plans are finalised in the run phase after reading those
 * repos, and are intentionally absent until then rather than guessed (a wrong
 * answer key would silently mis-grade the benchmark).
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { RepoType } from "./types.ts";
import type { PlanEntry } from "./tasks.ts";

/** How to turn a project type into a pinned, throwaway copy on disk. */
export interface RepoConfig {
  id: string;
  type: RepoType;
  /** Human description for the report. */
  description: string;
  /**
   * Materialise the repo into `dest` (which the caller has emptied) and return the
   * path to run `claude` in (usually `dest` itself). Deterministic: same ref in,
   * same bytes out. Must not mutate any source outside `dest`.
   */
  materialise(dest: string): string;
}

/** A repo plus its answer keys: the unit the runner iterates over. */
export interface RepoPlan {
  config: RepoConfig;
  entries: PlanEntry[];
}

/** Copy a local directory tree into dest (used for the small-ts self-repo). */
function copyTree(from: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(from, dest, { recursive: true });
}

/**
 * Extract a local git repo at a ref into dest via `git archive`, so only tracked
 * files at that exact commit are copied (no vendor/, no node_modules, no local
 * edits). The repo is left completely untouched.
 */
export function materialiseFromGitArchive(repoPath: string, ref: string, dest: string): string {
  mkdirSync(dest, { recursive: true });
  // git archive <ref> | tar -x -C dest. Use a pipe via the shell-free two-step:
  // write the archive to a temp tar, then extract. Keeps it cross-platform.
  const tarPath = join(dest, "_archive.tar");
  execFileSync("git", ["-C", repoPath, "archive", "--format=tar", "-o", tarPath, ref], {
    stdio: "pipe",
  });
  execFileSync("tar", ["-x", "-f", tarPath, "-C", dest], { stdio: "pipe" });
  rmSync(tarPath, { force: true });
  return dest;
}

/** Clone a remote repo and check out a pinned commit into dest. Network at run time. */
export function materialiseClone(url: string, ref: string, dest: string): string {
  execFileSync("git", ["clone", "--quiet", url, dest], { stdio: "pipe" });
  execFileSync("git", ["-C", dest, "checkout", "--quiet", ref], { stdio: "pipe" });
  return dest;
}

/**
 * The small-ts repo: Knowstone's own plugin source, copied standalone. Small,
 * real TypeScript with a package.json, a tsconfig, relative imports and a clear
 * CLI entry point — a fair "small repo" test bed whose answers we can verify from
 * this repository. KN_BENCH_SMALL_TS_SRC overrides the source path.
 */
export const SMALL_TS: RepoConfig = {
  id: "small-ts-knowstone",
  type: "small-ts",
  description: "Knowstone's own plugin source (small TypeScript, CLI + library).",
  materialise(dest: string): string {
    const src = process.env.KN_BENCH_SMALL_TS_SRC ?? defaultSmallTsSrc();
    for (const sub of ["src", "package.json", "tsconfig.json", "README.md"]) {
      try {
        copyTree(join(src, sub), join(dest, sub));
      } catch {
        // A missing optional file (e.g. README) is fine; src is the only essential.
      }
    }
    return dest;
  },
};

/** plugins/knowstone, resolved relative to this file (benchmarks/..). */
function defaultSmallTsSrc(): string {
  const here = new URL(".", import.meta.url).pathname;
  // On Windows the pathname is like /C:/..., which fs accepts after trimming the
  // leading slash before a drive letter.
  const normalised = /^\/[A-Za-z]:\//.test(here) ? here.slice(1) : here;
  return join(normalised, "..");
}

/**
 * The fully-worked answer key for the small-ts repo. Every `expected` token is
 * verified against the plugin source in this repository (see the comments). The
 * adversarial t9 edits the version constant mid-session: serving the pre-edit
 * "0.1.0" after it has been changed is a stale serve and a correctness failure.
 */
export const SMALL_TS_PLAN: RepoPlan = {
  config: SMALL_TS,
  entries: [
    // src/cli.ts carries the `import.meta.url === …` main guard: the CLI entry.
    { taskId: "t1-entry-points", expected: ["cli.ts"] },
    // The secret-scan guard lives in src/secret-guard.ts.
    { taskId: "t2-locate-feature", target: "the secret-scan guard", expected: ["secret-guard"] },
    // src/cli.ts imports the indexer, freshness and store modules.
    {
      taskId: "t3-module-deps",
      target: "src/cli.ts",
      expected: ["indexer", "freshness", "store"],
    },
    // package.json test script is "vitest run".
    { taskId: "t6-run-tests", expected: ["vitest"] },
    // Seeded verified finding (Tier-B) about how freshness status is handled.
    {
      taskId: "t7-recall-decision",
      target: "how a fact's freshness status is stored",
      expected: ["derived on read"],
      seed: {
        statement:
          "Decision: freshness status is derived on read and never stored, so the stale flag cannot itself go stale.",
        evidence: ["src/freshness.ts"],
      },
    },
    // Seeded root-cause finding.
    {
      taskId: "t8-recall-rootcause",
      target: "stale findings being re-served after code changes",
      expected: ["re-verify"],
      seed: {
        statement:
          "Root cause: a fact must be withheld for re-verify once its cone changes; auto-restoring on a re-matching hash would silently re-serve a stale fact.",
        evidence: ["src/freshness.ts"],
      },
    },
    // ADVERSARIAL (direct): the version constant in src/index.ts. Seed a finding
    // stating it is 0.1.0, then edit it mid-session to 9.9.9-bench. The plugin must
    // withhold the finding (index.ts changed) and the answer must be the new value.
    {
      taskId: "t9-adversarial-direct",
      target: "KNOWSTONE_VERSION (in src/index.ts)",
      freshValue: "9.9.9-bench",
      staleValue: "0.1.0",
      seed: {
        statement: "The engine version constant KNOWSTONE_VERSION is 0.1.0.",
        evidence: ["src/index.ts"],
      },
      edit: {
        file: "src/index.ts",
        from: 'export const KNOWSTONE_VERSION = "0.1.0";',
        to: 'export const KNOWSTONE_VERSION = "9.9.9-bench";',
      },
    },
  ],
};

/**
 * Registry of the plans ready to run. Only fully-worked, verified plans appear
 * here; asking the runner for a repo without a plan is an explicit error, never a
 * silently skipped or guessed answer key.
 */
export const PLANS: Record<string, RepoPlan> = {
  [SMALL_TS.id]: SMALL_TS_PLAN,
};

/** Look up a plan by repo id. Throws with a clear message if it is not ready. */
export function planFor(repoId: string): RepoPlan {
  const plan = PLANS[repoId];
  if (!plan) {
    throw new Error(
      `no answer key for repo "${repoId}" yet — finalise its PlanEntry list in repos.ts before running (answer keys are never guessed)`,
    );
  }
  return plan;
}
