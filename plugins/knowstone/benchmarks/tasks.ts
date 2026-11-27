/**
 * Knowstone benchmark — the fixed, pre-registered task battery.
 *
 * Ten realistic tasks with gradable outcomes (research/05 §5.6 asks for 8-15).
 * Each task is a TEMPLATE: it is bound to a repo by a PlanEntry (from ./repos.ts)
 * that supplies the concrete target and the expected answer tokens, so the SAME
 * battery runs across every project type while each has crisp, checkable answers.
 * The battery is fixed here and never tuned per run, which is what "pre-registered"
 * means: we commit to the tasks and the grading before we see the numbers.
 *
 * Categories:
 *   T1-T3  orientation   (entry points, locate a feature, a file's dependencies)
 *   T4-T6  derived facts (a route, a table's columns, how to run the tests)
 *   T7-T8  verified-finding recall (a recorded decision, a recorded root cause)
 *   T9-T10 ADVERSARIAL   (a value is edited mid-session; a stale serve = FAILURE)
 *
 * Tasks T7-T10 depend on a finding having been recorded first; the runner seeds
 * those into the ON arm's store deterministically (via the plugin CLI, not the
 * model) before the measured session. The OFF arm has no store, so it must derive
 * the answer from the code each time — which is exactly the baseline we measure
 * against.
 */

import type { Grade, RepoType, Task } from "./types.ts";
import { containsAll, gradeAdversarial } from "./grade.ts";

/**
 * Per-repo binding for one task. `target` fills the prompt; `expected` are tokens
 * a correct answer must contain. Adversarial tasks add fresh/stale values and the
 * edit the runner applies mid-session.
 */
export interface PlanEntry {
  taskId: string;
  /** Substituted into the prompt's ${target}. */
  target?: string;
  /** Tokens a correct answer must contain (non-adversarial grading). */
  expected?: string[];
  /** For a recall/finding task: the statement to seed, and its evidence file(s). */
  seed?: { statement: string; evidence: string[] };
  /** Adversarial only: the value that is correct AFTER the edit. */
  freshValue?: string;
  /** Adversarial only: the value correct BEFORE the edit; serving it now = stale. */
  staleValue?: string;
  /** Adversarial only: the edit applied to the working copy mid-session. */
  edit?: { file: string; from: string; to: string };
}

/** Fill ${target} in a prompt template. A missing target leaves the literal out. */
function fill(template: string, target: string | undefined): string {
  return template.replace(/\$\{target\}/g, target ?? "");
}

/** Standard keyword grade for a non-adversarial task. */
function keywordGrade(answer: string, expected: string[] | undefined): Grade {
  if (!expected || expected.length === 0) {
    return { correct: false, staleServed: false, note: "no expected tokens configured" };
  }
  const correct = containsAll(answer, expected);
  return {
    correct,
    staleServed: false,
    note: correct
      ? `found all of: ${expected.join(", ")}`
      : `missing one of: ${expected.join(", ")}`,
  };
}

const ALL: RepoType[] = ["small-ts", "legacy-php", "mid-ts", "large", "node-ts"];

/**
 * A planned, ready-to-run task: the concrete prompt plus a bound grader. Produced
 * by binding a Task template to a repo's PlanEntry.
 */
export interface PlannedTask {
  id: string;
  adversarial: boolean;
  prompt: string;
  expected: string;
  grade(answer: string): Grade;
  /** The seed/edit data the runner needs (passed through from the PlanEntry). */
  entry: PlanEntry;
}

/** Bind a task template to a repo entry, yielding a runnable PlannedTask. */
export function planTask(task: Task, entry: PlanEntry): PlannedTask {
  return {
    id: task.id,
    adversarial: task.adversarial,
    prompt: fill(task.prompt, entry.target),
    expected: task.expected,
    grade: bindGrade(task, entry),
    entry,
  };
}

/**
 * The battery. Prompts ask the model to answer concisely so the grader has a
 * tight answer to judge and the token axes are not swamped by prose. Graders read
 * expected tokens off the PlanEntry at runtime via a closure captured in planTask;
 * the template's own grade() is only used for adversarial tasks (which need the
 * fresh/stale context), so non-adversarial grade() here is a thin keyword check
 * that planTask re-binds with the entry's expected tokens.
 */
export const TASKS: Task[] = [
  {
    id: "t1-entry-points",
    appliesTo: ALL,
    adversarial: false,
    prompt:
      "What are the entry point(s) of this project — where does execution start? Answer with just the file path(s), concisely.",
    expected: "the project's real entry file path(s)",
  },
  {
    id: "t2-locate-feature",
    appliesTo: ALL,
    adversarial: false,
    prompt: "Where is ${target} implemented in this codebase? Give the file path(s), concisely.",
    expected: "the file path(s) implementing the named feature",
  },
  {
    id: "t3-module-deps",
    appliesTo: ALL,
    adversarial: false,
    prompt: "What does ${target} import or depend on within this repo? List the files, concisely.",
    expected: "the in-repo files the target imports",
  },
  {
    id: "t4-route-lookup",
    appliesTo: ["legacy-php", "mid-ts", "large", "node-ts"],
    adversarial: false,
    prompt: "What route or endpoint handles ${target}? Give the path and the handler, concisely.",
    expected: "the route path and its handler",
  },
  {
    id: "t5-schema-columns",
    appliesTo: ["legacy-php", "mid-ts", "large", "node-ts"],
    adversarial: false,
    prompt: "What columns does the ${target} table have? List the column names, concisely.",
    expected: "the column names of the named table",
  },
  {
    id: "t6-run-tests",
    appliesTo: ["small-ts", "mid-ts", "large", "node-ts"],
    adversarial: false,
    prompt: "How do I run this project's tests? Give the exact command, concisely.",
    expected: "the test command",
  },
  {
    id: "t7-recall-decision",
    appliesTo: ALL,
    adversarial: false,
    prompt:
      "Is there a recorded decision or rationale for ${target} in this project? If so, state it concisely.",
    expected: "the recorded rationale (seeded as a finding for the ON arm)",
  },
  {
    id: "t8-recall-rootcause",
    appliesTo: ALL,
    adversarial: false,
    prompt:
      "Is there a recorded root cause for the known issue with ${target}? If so, state it concisely.",
    expected: "the recorded root cause (seeded as a finding for the ON arm)",
  },
  {
    id: "t9-adversarial-direct",
    appliesTo: ALL,
    adversarial: true,
    prompt:
      "What is the current value of ${target} in this code? Answer with just the value. If you cannot confirm it from the current code, say so.",
    expected: "the value AFTER the mid-session edit; the pre-edit value is a stale serve",
  },
  {
    id: "t10-adversarial-transitive",
    appliesTo: ["small-ts", "mid-ts", "large", "node-ts"],
    adversarial: true,
    prompt:
      "Based on what ${target} relies on, what is the current value? Answer with just the value. If you cannot confirm it from the current code, say so.",
    expected:
      "the value AFTER editing a transitively-imported file; the pre-edit value is a stale serve",
  },
];

/**
 * Re-bind a non-adversarial PlannedTask's grader to the entry's expected tokens.
 * Kept separate from planTask so the template objects above stay simple and the
 * keyword grading lives in one place. Adversarial tasks keep their own grader.
 */
export function bindGrade(task: Task, entry: PlanEntry): (answer: string) => Grade {
  if (task.adversarial) {
    return (answer: string) =>
      gradeAdversarial(answer, entry.freshValue ?? "", entry.staleValue ?? "");
  }
  return (answer: string) => keywordGrade(answer, entry.expected);
}

/** Look up a task template by id. Throws if the id is not in the battery. */
export function taskById(id: string): Task {
  const task = TASKS.find((t) => t.id === id);
  if (task === undefined) throw new Error(`unknown task id: ${id}`);
  return task;
}

/** Exported for a sanity check in tests: the battery has no duplicate ids. */
export function taskIds(): string[] {
  return TASKS.map((t) => t.id);
}
