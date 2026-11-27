/**
 * Knowstone — the local fact store.
 *
 * Facts (a remembered structural detail or a verified finding) are kept on disk,
 * isolated per project, and never deleted: a fact that no longer holds is marked
 * superseded, keeping the history. Every write runs through the secret guard
 * first, so a fact whose text looks like it contains a credential is refused and
 * never reaches disk. See ../../../PLAN.md (M2).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashContent } from "./hash.js";
import type { Binding } from "./freshness.js";
import { scanForSecrets } from "./secret-guard.js";

export type FactKind = "structure" | "finding";

export interface Fact {
  id: string;
  kind: FactKind;
  /** The remembered text. */
  statement: string;
  /** The evidence binding this fact depends on (from the freshness engine). */
  binding: Binding;
  createdAt: number;
  /** id of the fact that replaced this one, or null while this fact still stands. */
  supersededBy: string | null;
}

export interface FactInput {
  kind: FactKind;
  statement: string;
  binding: Binding;
  /** Defaults to Date.now(). */
  createdAt?: number;
}

/** Thrown when a fact is refused because its text looks like it contains secrets. */
export class SecretError extends Error {
  readonly kinds: string[];
  constructor(kinds: string[]) {
    const unique = [...new Set(kinds)].join(", ");
    super(`refused to store fact: text contains possible secrets [${unique}]`);
    this.name = "SecretError";
    this.kinds = kinds;
  }
}

export interface StoreOptions {
  /** Base directory for all Knowstone data (for example CLAUDE_PLUGIN_DATA). */
  baseDir: string;
  /** Absolute path of the project this store belongs to; used to isolate projects. */
  projectRoot: string;
}

export interface ListOptions {
  /** Include facts that have been superseded. Default false. */
  includeSuperseded?: boolean;
}

export interface KnowstoneStore {
  /** Store a new fact. Throws SecretError if the statement looks like it contains secrets. */
  put(input: FactInput): Fact;
  get(id: string): Fact | undefined;
  list(options?: ListOptions): Fact[];
  /** Replace a fact: mark the old one superseded (never deleted) and add the new one. */
  supersede(oldId: string, input: FactInput): Fact;
  /** The on-disk path backing this store. */
  readonly path: string;
}

interface StoreFile {
  version: number;
  facts: Fact[];
}

const STORE_VERSION = 1;

/**
 * Canonical absolute form of a project root, resolving 8.3 short names,
 * drive-letter case and symlinks so independent entry points (a skill run from
 * the project cwd, the SessionStart hook reading CLAUDE_PROJECT_DIR) key the same
 * project to the same store. Best-effort: falls back to the given path if it
 * cannot be resolved (for example it does not exist).
 */
export function canonicalProjectRoot(projectRoot: string): string {
  try {
    return realpathSync.native(projectRoot);
  } catch {
    return projectRoot;
  }
}

/** A short, stable key for a project, derived from its absolute path. */
function projectKey(projectRoot: string): string {
  const normalised = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return hashContent(normalised).slice(0, 16);
}

/**
 * The per-project data directory for a store: baseDir/projects/<key>. Exposed so
 * sibling caches (for example the Tier-A index cache) can live alongside the
 * facts file under the same project-isolated key.
 */
export function projectDir(options: StoreOptions): string {
  return join(options.baseDir, "projects", projectKey(options.projectRoot));
}

export function openStore(options: StoreOptions): KnowstoneStore {
  const dir = projectDir(options);
  const filePath = join(dir, "facts.json");

  const load = (): StoreFile => {
    if (!existsSync(filePath)) return { version: STORE_VERSION, facts: [] };
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoreFile>;
      if (!parsed || !Array.isArray(parsed.facts)) return { version: STORE_VERSION, facts: [] };
      return { version: parsed.version ?? STORE_VERSION, facts: parsed.facts };
    } catch {
      // A corrupt store must never crash the plugin: start empty in memory and
      // leave the file untouched until the next successful write.
      return { version: STORE_VERSION, facts: [] };
    }
  };

  const byId = new Map<string, Fact>(load().facts.map((f): [string, Fact] => [f.id, f]));

  const persist = (): void => {
    mkdirSync(dir, { recursive: true });
    const out: StoreFile = { version: STORE_VERSION, facts: [...byId.values()] };
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
    renameSync(tmp, filePath);
  };

  const guard = (statement: string): void => {
    const scan = scanForSecrets(statement);
    if (!scan.safe) throw new SecretError(scan.findings.map((f) => f.kind));
  };

  const create = (input: FactInput): Fact => ({
    id: randomUUID(),
    kind: input.kind,
    statement: input.statement,
    binding: input.binding,
    createdAt: input.createdAt ?? Date.now(),
    supersededBy: null,
  });

  return {
    path: filePath,

    put(input: FactInput): Fact {
      guard(input.statement); // refuse secrets before anything touches disk
      const fact = create(input);
      byId.set(fact.id, fact);
      persist();
      return fact;
    },

    get(id: string): Fact | undefined {
      return byId.get(id);
    },

    list(listOptions?: ListOptions): Fact[] {
      const includeSuperseded = listOptions?.includeSuperseded ?? false;
      const all = [...byId.values()];
      const chosen = includeSuperseded ? all : all.filter((f) => f.supersededBy === null);
      return chosen.sort((a, b) => a.createdAt - b.createdAt);
    },

    supersede(oldId: string, input: FactInput): Fact {
      guard(input.statement); // refuse secrets before any mutation
      const existing = byId.get(oldId);
      if (existing === undefined) {
        throw new Error(`cannot supersede unknown fact id "${oldId}"`);
      }
      const replacement = create(input);
      byId.set(oldId, { ...existing, supersededBy: replacement.id });
      byId.set(replacement.id, replacement);
      persist();
      return replacement;
    },
  };
}
