# Knowstone — Development Plan

Status: **plan for approval**. No plugin code is written until this plan is signed off.
Grounded in the research in [`research/`](./research/) (read `research/01-executive-summary.md`
and `research/05-product-architecture-security-benchmark.md` first).

This plugin will be **published for everyone**, so "it must function properly" is a hard
requirement: every milestone ends with an explicit test-and-verify gate, and nothing ships
on an unmeasured claim.

---

## 0. What we are building (one paragraph)

Knowstone is a local-first Claude Code plugin that stores two kinds of project knowledge —
**derived facts** (structure, DB schema, routes, module graph) and **verified findings**
(bug root causes, architectural decisions, conventions) — in a local SQLite store, binds
each fact to the content hash of the code it came from (an Assay-style "dependency cone"),
and **refuses to serve a fact once that code changes**, holding it for human
re-verification instead of silently re-serving or auto-restoring it. Lean footprint:
skills + local scripts, no always-on MCP, no external services, no secrets cached.

---

## 1. Milestone overview

| # | Milestone | Goal | Exit gate (verify) |
|---|-----------|------|--------------------|
| M0 | Repo & governance | Installable skeleton, CI, licence, name secured | `claude plugin validate` passes on an empty-but-valid plugin; CI green |
| M1 | Freshness engine (the core bet) | Hashing + cone + check-order that withholds stale facts | Adversarial test: edit a file mid-run → the dependent fact is **withheld**, on git and no-git repos |
| M2 | Storage + secret guard | SQLite schema (Tier A/B), migrations, versioning, secret-scan | Round-trip + corruption-recovery + secret-redaction tests pass |
| M3 | Indexer + extractors | Structure/schema/route extraction, pluggable, generic + PHP/Laravel + Node first | Index of the ERP + a Node fixture matches reality (spot-checked) |
| M4 | Skills + session card | `map`, `note`, `recall` wired to the engine; tiny static SessionStart card | End-to-end on the ERP: note → recall → edit → "needs re-verify" |
| M5 | Hardening | Degradation paths, isolation, size caps, logging | Fault-injection suite passes; no cross-project bleed |
| M6 | Benchmark | Caching-aware A/B incl. adversarial stale-file tasks, ≥3 project types | Measured result + **0 stale serves**; honest write-up |
| M7 | Package & publish | Docs, `plugin eval`, marketplace entry | Fresh-machine install works; eval suite green |

V1 features (`verify`, impact query, global fingerprints, more extractors) are planned
after M7 and listed in §4.

---

## 2. Cross-cutting decisions to lock before M1

These shape everything; see §5 for the ones I need you to confirm.

- **Implementation runtime:** proposed **Node.js + TypeScript** (most Claude Code users
  already have Node; clean npm distribution; tree-sitter has mature Node bindings;
  cross-platform incl. your Windows box). Alternatives weighed: Python (common but adds a
  venv story), Go/Rust compiled binary (zero runtime, but cross-platform build/release is
  heavier for MVP). **Confirm in §5.**
- **Change-detection hash:** **xxh3-64** for speed on the Merkle/file layer (change
  detection does not need a cryptographic hash); keep a path→hash map. Revisit only if a
  collision risk argument appears.
- **Fact binding unit:** **module = directory up to a configurable depth** (default depth
  to be tuned in M1); cone over the import graph (Assay). Default depth is a config value,
  not hardcoded.
- **Language coverage order:** generic (filesystem/structure) → **PHP/Laravel** (your test
  bed) → **Node/TypeScript** → Python → Go → others. Extractors are pluggable so coverage
  grows without touching the core.
- **Licence:** proposed **MIT** (maximally reusable; note Serena is GPL and claude-remember
  is non-OSS, so we build clean-room and copy no code). **Confirm in §5.**
- **Repo layout:** marketplace repo; Knowstone at `plugins/knowstone/`. Stated assumption.

---

## 3. Milestones in detail

### M0 — Repository & governance
**Goal:** a valid, installable, CI-checked skeleton people could (trivially) install.
**Tasks**
- Secure the name: check `knowstone` / `claude-knowstone` free on npm, GitHub, and the
  plugin marketplace; pick the final name (fallback: *Lodestar*, *Anchor*).
- `.claude-plugin/marketplace.json` (owner, plugins array) and
  `plugins/knowstone/.claude-plugin/plugin.json` (name required; version, description,
  author, licence, keywords).
- `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, `SECURITY.md`.
- Tooling: TypeScript config, linter + formatter, test runner, `package.json` scripts.
- CI (GitHub Actions): install, lint, typecheck, test, `claude plugin validate` on
  Linux + macOS + Windows (cross-platform is a release requirement).
**Deliverables:** skeleton repo that validates and has green CI.
**Exit/verify:** `claude plugin validate plugins/knowstone` passes; CI green on 3 OSes;
installing the empty plugin locally does nothing harmful and loads cleanly.

### M1 — Freshness engine (the differentiator; de-risk first)
**Goal:** prove the core bet before building anything around it.
**Tasks**
- `kn-hash`: file hashing, Merkle tree over the tree, import-graph extraction (start with
  PHP + JS/TS import parsing), cone-hash in reverse-topological order (collapse cycles).
- `kn-freshness`: the check order from `research/04` §1.5 — tool_version → TTL → global
  binding → git fast-path → mtime/size → content hash → cone hash; **status derived on
  read, never stored**; **forced re-verify** (no auto-restore).
- Both git and **no-git** code paths (this repo and local-first users have no `.git` in
  some dirs).
- Unit tests + a fixture repo with known import edges; property tests for the Merkle fold.
**Deliverables:** two tested library modules + a CLI harness to inspect freshness.
**Exit/verify (the critical gate):** on a fixture **and** on the real ERP repo —
  1. record a fact bound to module A's cone;
  2. edit a file inside A's cone;
  3. assert `recall` **withholds** the fact as "needs re-verify";
  4. edit an unrelated module; assert the fact is **still served**;
  5. repeat 1-4 with git absent.
If any of these fail, we stop and rethink before proceeding.

### M2 — Storage layer + secret guard
**Goal:** durable, versioned, safe local store.
**Tasks**
- SQLite schema: `files` (path, mtime, size, hash), `merkle`, `modules`/`cones`,
  `facts_derived` (Tier A), `findings` (Tier B: claim record from `research/04` §1.4 with
  supersede-chain), `cache_meta` (tool_version, global fingerprints), FTS5 for recall.
- Schema versioning → on version bump, rebuild Tier A (regenerable), migrate Tier B
  (precious).
- Storage location: `${CLAUDE_PLUGIN_DATA}` + per-project git-ignored cache; strict
  per-project isolation keying.
- **Secret-scan guard** run before every write (entropy + known patterns + `.env`/key
  filenames); redact or refuse; unit tests with planted fake secrets.
**Deliverables:** storage module + migration tool + secret guard.
**Exit/verify:** write/read/supersede round-trip tests; kill-and-reopen (no corruption);
version-bump rebuild test; **secret-redaction test** proves no planted secret is ever
written.

### M3 — Indexer + extractors
**Goal:** turn a repo into Tier-A facts.
**Tasks**
- `kn-index`: walk repo (respect ignore rules; skip binary/generated; symlinks recorded
  not followed), build structure/dir inventory, entry points, module/import graph.
- Pluggable extractors: generic first; **PHP/Laravel** (routes, Eloquent models/schema
  from migrations); **Node/TS** (package.json scripts, Express/Nest routes). DB schema via
  a safe, read-only path (e.g. parse migrations; optional user-approved `--schema-only`
  dump — never auto-connecting to a live DB without consent).
- Incremental update using the Merkle diff (only changed modules re-extracted).
**Deliverables:** indexer + 2-3 extractors.
**Exit/verify:** index of the ERP and a Node fixture; spot-check routes/models/entry
points against reality; incremental update after an edit touches only the right modules.

### M4 — Skills + session card
**Goal:** the user-facing surface.
**Tasks**
- `skills/map/SKILL.md` (build/refresh index), `note/SKILL.md` (record a finding, capture
  evidence), `recall/SKILL.md` (freshness-gated query). Short descriptions = low idle cost.
- `hooks/hooks.json`: SessionStart injects the **tiny, static** project card
  (additionalContext; do not depend on user-visible SessionStart output — documented
  plugin limitation).
- Keep deterministic work in `bin/` scripts; skills call scripts, parse concise output.
**Deliverables:** three skills + the card hook.
**Exit/verify:** full end-to-end in a real Claude Code session on the ERP: map → note a
root cause → recall it → edit the implicated file → recall now says "needs re-verify".

### M5 — Hardening
**Goal:** behaves well when things go wrong (publish requirement).
**Tasks**
- Degradation: no git, corrupt cache (rebuild), extractor failure (fall back to "unknown,
  must explore" — never serve a guess), huge repo (Merkle keeps it cheap), monorepo.
- Per-project isolation hardening; cache-size caps (LRU on Tier A, never evict Tier B);
  structured JSONL logging incl. every freshness decision.
- Windows/macOS/Linux path and FS edge cases.
**Deliverables:** fault-injection test suite.
**Exit/verify:** suite passes on 3 OSes; a deliberately corrupted cache self-heals; no
cross-project data bleed.

### M6 — Benchmark (the proof)
**Goal:** honest, measured evidence — or an honest "benefit is modest".
**Tasks**
- Implement the `research/05` §5.6 protocol: fixed task battery, interleaved A/B, ≥5
  reps, metrics pulled from the API `usage` object, caching-aware cost maths.
- **Adversarial stale-file tasks** (edit mid-session) where a stale serve = correctness
  failure, not a saving.
- Run on: small repo, large repo, legacy PHP, the Laravel ERP, Node/TS.
**Deliverables:** `benchmarks/` harness + a written results report (median + IQR, all four
axes, correctness graded blind).
**Exit/verify:** report produced; **0 stale serves** on adversarial tasks; README claims
are limited to what this run measured. If the benefit is marginal, we say so plainly.

### M7 — Package & publish
**Goal:** anyone can install it and it works.
**Tasks**
- User docs (capability-first, no borrowed %), honest README, troubleshooting, privacy
  statement, uninstall/forget instructions.
- `claude plugin eval` suite; final `claude plugin validate`.
- Marketplace entry; versioned release; changelog.
- Fresh-machine install test (clean VM/container per OS).
**Deliverables:** v0.1.0 release candidate.
**Exit/verify:** clean-machine install on 3 OSes performs map/note/recall correctly; eval
suite green. **Then, and only then, do we ask you before publishing publicly.**

---

## 4. After MVP (V1+) — not in scope now
`knowstone:verify` (re-attest, append superseding record); "what does changing X
invalidate?" impact query; lockfile/schema/config global fingerprints wired in;
framework extractors (Symfony, Django, Spring, Go); optional opt-in team/cross-machine
sync (encrypted, findings-only); optional local semantic search (only if M6 shows it
earns its weight).

## 5. Decisions I need from you before starting M1
1. **Runtime:** Node.js + TypeScript (my recommendation) vs Python vs a Go/Rust binary.
2. **Licence:** MIT (my recommendation) vs something else.
3. **Author/attribution** for `plugin.json` and `LICENSE` (name or org to credit).
4. Confirm the **marketplace repo layout** (Knowstone at `plugins/knowstone/`) is what you want.

## 6. Working rules for this build
- A live progress tracker reprinted at each milestone gate.
- Test-and-verify step closes every milestone; no "done" without a shown result.
- No git commit/push, no destructive action, no DB write, no sending code to any external
  service without asking you first.
- Smallest change that does the job; match conventions; no scope creep.
- Every efficiency claim traces to the M6 benchmark, never to a blog figure.
