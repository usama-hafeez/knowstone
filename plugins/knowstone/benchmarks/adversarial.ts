/**
 * Knowstone benchmark — the adversarial stale-file correctness harness (FREE).
 *
 * This is the rigorous proof of Knowstone's primary claim, and it costs nothing:
 * no model, no API, no subscription usage. It drives the REAL engine through the
 * same CLI the skills call (`runCli`): record a verified finding bound to the
 * dependency cone of its evidence, change a file INSIDE that cone, then recall —
 * and assert the finding is WITHHELD for re-verification. Serving it as FRESH
 * after the edit is a stale serve and a correctness FAILURE, never a saving.
 *
 * It also runs a control (an edit OUTSIDE the cone) to prove the engine is not
 * simply withholding everything: an unrelated change must leave the fact FRESH.
 * Scenarios cover direct and transitive edits, TypeScript and PHP, and the no-git
 * path (temp fixtures have no .git), so the guarantee is checked across the shapes
 * the real product meets. See ../../../PLAN.md (M6) and research/05 §5.6.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type CliEnv } from "../src/cli.js";

export type ProjectType = "ts-direct" | "ts-transitive" | "php-require" | "control-unrelated";

/** A single adversarial scenario: a fixture repo, a finding, and an edit. */
export interface Scenario {
  id: string;
  projectType: ProjectType;
  /** repo-relative path -> file content. */
  files: Record<string, string>;
  /** Evidence file(s) the finding is bound to. */
  evidence: string[];
  /** The statement to record (kept distinctive so it is easy to find in output). */
  statement: string;
  /** The file to edit and the substring replacement to apply. */
  edit: { file: string; from: string; to: string };
  /**
   * True when the edit is inside the finding's cone, so recall MUST withhold it.
   * False for the control (an unrelated edit), where recall must keep it FRESH.
   */
  expectWithheld: boolean;
}

export interface ScenarioResult {
  id: string;
  projectType: ProjectType;
  /** What recall did after the edit. */
  served: "FRESH" | "WITHHELD" | "ERROR";
  /** True iff the engine served a fact whose cone had changed (the failure mode). */
  staleServed: boolean;
  /** True iff the engine behaved as the scenario requires. */
  pass: boolean;
  detail: string;
}

/** Collect CLI output into a buffer so a scenario can inspect it. */
function capture(): { env: Omit<CliEnv, "baseDir" | "cwd" | "now">; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { env: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/**
 * Run one scenario end-to-end against the real engine and return its verdict.
 * Deterministic: a fixed clock, temp dirs cleaned up, no network, no git.
 */
export function runScenario(scenario: Scenario): ScenarioResult {
  const now = 1_700_000_000_000; // fixed clock for determinism
  const projectRoot = mkdtempSync(join(tmpdir(), "kn-adv-proj-"));
  const dataDir = mkdtempSync(join(tmpdir(), "kn-adv-data-"));

  const fail = (detail: string): ScenarioResult => ({
    id: scenario.id,
    projectType: scenario.projectType,
    served: "ERROR",
    staleServed: false,
    pass: false,
    detail,
  });

  try {
    // Materialise the fixture.
    for (const [rel, content] of Object.entries(scenario.files)) {
      const abs = join(projectRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }

    // Record the finding, bound to the current (pre-edit) cone state.
    const note = capture();
    const noteCode = runCli(
      [
        "note",
        "--project",
        projectRoot,
        "--statement",
        scenario.statement,
        "--evidence",
        scenario.evidence.join(","),
      ],
      { baseDir: dataDir, cwd: projectRoot, now, ...note.env },
    );
    if (noteCode !== 0) return fail(`note exited ${noteCode}: ${note.err.join(" ")}`);
    // The finding must be FRESH at birth, or the fixture (not the engine) is wrong.
    if (!note.out.some((l) => /Status: FRESH/.test(l))) {
      return fail(`finding was not FRESH at creation: ${note.out.join(" | ")}`);
    }

    // Apply the edit (inside the cone for an adversarial case, outside for control).
    const target = join(projectRoot, scenario.edit.file);
    const before = readFileSync(target, "utf8");
    if (!before.includes(scenario.edit.from)) {
      return fail(`edit anchor not found in ${scenario.edit.file}`);
    }
    writeFileSync(target, before.replace(scenario.edit.from, scenario.edit.to), "utf8");

    // Recall after the edit.
    const recall = capture();
    const recallCode = runCli(["recall", "--project", projectRoot], {
      baseDir: dataDir,
      cwd: projectRoot,
      now: now + 1000,
      ...recall.env,
    });
    if (recallCode !== 0) return fail(`recall exited ${recallCode}: ${recall.err.join(" ")}`);

    const served = classifyRecall(recall.out, scenario.statement);
    if (served === "NOT_FOUND") return fail(`finding missing from recall output`);

    const staleServed = scenario.expectWithheld && served === "FRESH";
    const pass = scenario.expectWithheld ? served === "WITHHELD" : served === "FRESH";
    return {
      id: scenario.id,
      projectType: scenario.projectType,
      served,
      staleServed,
      pass,
      detail: pass
        ? scenario.expectWithheld
          ? "withheld after in-cone edit (correct)"
          : "kept FRESH after unrelated edit (correct)"
        : staleServed
          ? "STALE SERVE: served a fact whose cone changed"
          : `unexpected: served=${served}, expectWithheld=${scenario.expectWithheld}`,
    };
  } catch (error) {
    return fail(`threw: ${(error as Error).message}`);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Decide where the statement appeared in recall output. The recall command prints
 * a "FRESH — safe to use" block then a "NEEDS RE-VERIFY" block; a statement in the
 * first block is being served as current, in the second it is withheld.
 */
function classifyRecall(lines: string[], statement: string): "FRESH" | "WITHHELD" | "NOT_FOUND" {
  const holdHeader = lines.findIndex((l) => /NEEDS RE-VERIFY/.test(l));
  const idx = lines.findIndex((l) => l.includes(statement));
  if (idx === -1) return "NOT_FOUND";
  if (holdHeader === -1) return "FRESH"; // no hold block at all => served as fresh
  return idx < holdHeader ? "FRESH" : "WITHHELD";
}

/**
 * The scenario set. Imports are written so the cone resolves fully (no unresolved
 * imports), because a known-incomplete cone is withheld for a different reason and
 * would not isolate the content-change behaviour we are proving.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "ts-direct-edit",
    projectType: "ts-direct",
    files: {
      "a.ts": 'import { b } from "./b.js";\nexport const a = b + 1;\n',
      "b.ts": "export const b = 1;\n",
    },
    evidence: ["a.ts"],
    statement: "FINDING-ts-direct: the a module computes a from b.",
    edit: { file: "a.ts", from: "b + 1", to: "b + 2" },
    expectWithheld: true,
  },
  {
    id: "ts-transitive-edit",
    projectType: "ts-transitive",
    files: {
      "a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "b.ts": 'import { c } from "./c.js";\nexport const b = c;\n',
      "c.ts": "export const c = 1;\n",
    },
    evidence: ["a.ts"],
    statement: "FINDING-ts-transitive: a depends on c through b.",
    // Edit the transitively-imported c.ts; per-file binding would MISS this.
    edit: { file: "c.ts", from: "c = 1", to: "c = 999" },
    expectWithheld: true,
  },
  {
    id: "php-require-edit",
    projectType: "php-require",
    files: {
      // A relative include ("./b.php"): the engine resolves "." specifiers to repo
      // files, so a.php's cone includes b.php. A bare "b.php" would be treated as
      // external and is a different (resolution) case, not the one we prove here.
      "a.php": '<?php\nrequire_once "./b.php";\n$a = $b + 1;\n',
      "b.php": "<?php\n$b = 1;\n",
    },
    evidence: ["a.php"],
    statement: "FINDING-php: a.php includes b.php.",
    edit: { file: "b.php", from: "$b = 1", to: "$b = 2" },
    expectWithheld: true,
  },
  {
    id: "control-unrelated-edit",
    projectType: "control-unrelated",
    files: {
      "a.ts": 'import { b } from "./b.js";\nexport const a = b + 1;\n',
      "b.ts": "export const b = 1;\n",
      "unrelated.ts": "export const u = 0;\n",
    },
    evidence: ["a.ts"],
    statement: "FINDING-control: a computes from b.",
    // Edit a file OUTSIDE a's cone: the finding must stay FRESH.
    edit: { file: "unrelated.ts", from: "u = 0", to: "u = 1" },
    expectWithheld: false,
  },
];

/** Run every scenario and return the verdicts. */
export function runAll(): ScenarioResult[] {
  return SCENARIOS.map(runScenario);
}
