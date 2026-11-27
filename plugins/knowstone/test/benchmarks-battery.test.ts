import { describe, it, expect } from "vitest";
import { TASKS, taskIds, planTask, bindGrade, taskById } from "../benchmarks/tasks.ts";
import { SMALL_TS_PLAN } from "../benchmarks/repos.ts";
import { schedule } from "../benchmarks/run.ts";

describe("task battery", () => {
  it("has 10 tasks with unique ids and two adversarial ones", () => {
    expect(TASKS.length).toBe(10);
    expect(new Set(taskIds()).size).toBe(10);
    expect(TASKS.filter((t) => t.adversarial).map((t) => t.id)).toEqual([
      "t9-adversarial-direct",
      "t10-adversarial-transitive",
    ]);
  });

  it("taskById throws on an unknown id", () => {
    expect(() => taskById("nope")).toThrow();
  });

  it("planTask substitutes the target into the prompt", () => {
    const task = taskById("t2-locate-feature");
    const planned = planTask(task, {
      taskId: task.id,
      target: "the secret-scan guard",
      expected: ["secret-guard"],
    });
    expect(planned.prompt).toContain("the secret-scan guard");
    expect(planned.prompt).not.toContain("${target}");
  });

  it("keyword grading passes only when every expected token is present", () => {
    const task = taskById("t3-module-deps");
    const grade = bindGrade(task, { taskId: task.id, expected: ["indexer", "freshness", "store"] });
    expect(grade("cli.ts imports indexer, freshness and store").correct).toBe(true);
    expect(grade("cli.ts imports indexer and store").correct).toBe(false);
  });

  it("keyword grading accepts an alternative phrasing via expectedAny", () => {
    const task = taskById("t7-recall-decision");
    const grade = bindGrade(task, {
      taskId: task.id,
      expected: ["derived on read"],
      expectedAny: ["recomputed", "not stored"],
    });
    // Misses the literal 'derived on read' but states the concept another way.
    expect(grade("the status is recomputed from the binding each read").correct).toBe(true);
    expect(grade("the status is kept in a field on the fact").correct).toBe(false);
  });

  it("adversarial grading routes through gradeAdversarial", () => {
    const task = taskById("t9-adversarial-direct");
    const grade = bindGrade(task, {
      taskId: task.id,
      freshValue: "9.9.9-bench",
      staleValue: "0.1.0",
    });
    expect(grade("0.1.0").staleServed).toBe(true);
    expect(grade("9.9.9-bench").correct).toBe(true);
  });
});

describe("schedule", () => {
  it("interleaves arms and emits a warm-up per arm before the reps", () => {
    const plan = { config: SMALL_TS_PLAN.config, entries: [SMALL_TS_PLAN.entries[0]!] };
    const order = schedule(plan, 3);
    // one task: 2 warm-ups + 3 reps * 2 arms = 8 sessions
    expect(order.length).toBe(8);
    expect(order.filter((s) => s.warmup).length).toBe(2);
    expect(order.filter((s) => s.arm === "on").length).toBe(4);
    expect(order.filter((s) => s.arm === "off").length).toBe(4);
    // warm-ups come first
    expect(order[0]!.warmup).toBe(true);
    expect(order[1]!.warmup).toBe(true);
    expect(order[2]!.warmup).toBe(false);
  });

  it("skips tasks a repo has no answer key for", () => {
    const order = schedule(SMALL_TS_PLAN, 1);
    const scheduledIds = new Set(order.map((s) => s.task.id));
    // small-ts plan has no route/schema/transitive entries
    expect(scheduledIds.has("t4-route-lookup")).toBe(false);
    expect(scheduledIds.has("t1-entry-points")).toBe(true);
  });
});
