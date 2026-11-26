# 05 — Product, Architecture, Security, Benchmark & Roadmap

Covers brief Phases 4-8 and 9.7-9.12.

---

## 5.1 Product identity (Phase 5.1)

- **Name (provisional):** **Keystone** — not yet checked for clashes on npm / GitHub /
  the marketplace (HYPOTHESIS; verify before committing). Alternates: *Lodestar*, *Anchor*.
- **One-line description:** A local-first "verified memory" for Claude Code that stamps
  every project fact with the hash of the evidence it came from, and refuses to let Claude
  act on it once the code changes.
- **Value proposition:** Claude stops re-deriving (and mis-remembering) your project.
  Verified decisions and root causes persist across sessions, but **only while they're
  still true** — the moment their code changes, they're held for re-confirmation instead
  of silently misleading you.
- **Target developers:** engineers on non-trivial / long-lived / legacy codebases who
  return to a project repeatedly and care about correctness. A large, long-lived Laravel
  ERP is the archetype.
- **Primary use cases:** onboarding to an unfamiliar repo; returning after weeks;
  investigating a recurring bug; recording an architectural decision so it (and its
  validity) survives.
- **Key differentiators:** (1) **forced human re-verification** on change — no silent
  auto-restore (vs Kage/QuintinBotes/VRM); (2) **verified decisions/root-causes as
  first-class objects** (vs generic memory items); (3) **lean, local-first, key-free,
  mostly-skills** (vs heavy-MCP + external vector DB); (4) freshness as a **guarantee**,
  not a hope (vs claude-mem/Serena/Context7).

## 5.2 Feature prioritisation (Phase 5.2) — each with the problem it solves

### MVP (essential)
| Feature | Problem it solves |
|---------|-------------------|
| **Project card** (tiny SessionStart context, <500 tok, static) | Claude re-asks "what is this repo"; we give a stable, cache-friendly anchor without bloating context |
| **`keystone:map`** skill → deterministic structure/schema/route index in local SQLite, Merkle-keyed | Re-exploration every session (pain #5/#8); produces the cacheable Tier-A facts |
| **`keystone:note`** skill → record a verified finding with evidence hashes (cone binding) | Verified decisions/root-causes vanish between sessions (pain #2); nobody stores them as first-class |
| **`keystone:recall`** skill → query findings; **stale ones shown as "needs re-verify," never served as current** | The core trust gap: no tool forces re-verification on change |
| **Invalidation engine** (the file-04 check order; git + no-git paths) | "Do not trust stale information" — made real |
| **Secret-scan guard** before any write | Never cache credentials |

### V1 (important)
- `keystone:verify` — re-attest a stale finding (human or a defined test predicate);
  appends a superseding record (never overwrites).
- Impact query: "what verified facts does changing module X invalidate?" (uses the cone).
- Lockfile/schema/config global-fingerprint tracking wired into retrieval.
- `/context`-aware self-report: show Keystone's own idle footprint honestly (point to
  native `/skill-doctor` and `/usage` rather than build a cost meter [S-DOC-COST]).

### V2 (advanced)
- Optional team / cross-machine sync of Tier-B findings (opportunity O3; auto-memory is
  machine-local [S-DOC-MEM]) — explicit opt-in, encrypted, never includes source.
- Optional local semantic search over the map (only if the benchmark shows it beats native
  grep + the Merkle index enough to justify the weight).
- Framework-aware extractors (Laravel routes/Eloquent, Symfony, Express/Nest, Django,
  Spring, Go) as pluggable modules.

### Future (experimental)
- "Characterization note" mode: capture what code *currently does* as a verified fact with
  a test predicate (Assay-style evidence), for safe legacy refactors.
- PR-time: surface which verified decisions a diff puts into "needs re-verify."

## 5.3 User experience (Phase 5.3) — realistic workflows

1. **Joins an unfamiliar project:** `keystone:map` builds the structure/schema/route index
   once; the project card + recall give Claude a verified orientation instead of a
   multi-turn grep crawl.
2. **Investigates a production bug:** Claude finds the root cause; `keystone:note` records
   it bound to the cone of the fix. Next time the symptom recurs, `keystone:recall` surfaces
   it — *unless* that code changed, in which case it's flagged "re-verify," so nobody
   trusts a cause that no longer applies.
3. **Starts a complex feature:** records the architectural decision (ADR) as a verified
   finding; it persists and stays valid only while its modules are unchanged.
4. **Understands a legacy app:** map + verified "this is intentional because…" notes turn
   tribal knowledge into checked, decaying facts (the Fowler/JetBrains pain [S-FOWLER]).
5. **Security/perf audit:** findings recorded with evidence (command + exit + output hash);
   re-running later shows which still hold. (Review itself stays with native
   `/security-review` / `/code-review` — we store and freshness-gate the findings.)
6. **Reviews a PR:** (V2) Keystone flags which verified decisions the diff invalidates.
7. **Returns after weeks:** recall gives back only still-valid knowledge; anything whose
   code moved is held for re-confirmation — the exact "don't trust stale" guarantee.

## 5.4 Technical architecture (Phase 6)

### Design principles
Minimal always-on context (tiny static card only); progressive disclosure (skills load on
demand [S-DOC-SKILL]); deterministic work in scripts; local-first; cross-project via
per-project isolated stores; **don't rebuild native features** (see §5.4 "what we lean on").

### Proposed directory structure
```
keystone/
├── .claude-plugin/
│   ├── plugin.json            # manifest (name required) [S-DOC-PLUG]
│   └── marketplace.json       # if self-distributed
├── skills/
│   ├── map/SKILL.md           # build/refresh the index (short description = low idle cost)
│   ├── note/SKILL.md          # record a verified finding
│   ├── recall/SKILL.md        # query findings (freshness-gated)
│   └── verify/SKILL.md        # (V1) re-attest a stale finding
├── bin/                       # on PATH while enabled [S-DOC-PLUG]
│   ├── ks-index               # deterministic structure/schema/route extractor
│   ├── ks-hash                # Merkle + cone hashing
│   └── ks-freshness           # the check-order engine (file 04 §1.5)
├── hooks/hooks.json           # SessionStart: inject the tiny static card
└── (data at ${CLAUDE_PLUGIN_DATA} + per-project git-ignored cache)
```

### What each component is and why
- **Skills, not always-on prompts** — idle cost is just the capped listing budget
  [S-DOC-SKILL]; bodies load on invocation. This is the lean footprint.
- **Scripts in `bin/`** — hashing/extraction/freshness are deterministic; doing them in
  code (not model tokens) is the real efficiency lever (file 04 §2.4).
- **One SessionStart hook** — injects only the small **static** card (static = cache-safe;
  file 04 §2.3). Note the documented limit: a plugin's SessionStart `initialUserMessage`/
  `sessionTitle` are ignored if the plugin finishes installing after SessionStart runs
  [S-DOC-HOOKS] — so the card is additionalContext, and we don't depend on user-visible
  SessionStart output.
- **No always-on MCP server in MVP** — avoids idle tool-schema cost; Tool Search already
  defers MCP by default anyway [S-DOC-MCP]. (An optional MCP surface is a V2 call, measured.)
- **Storage:** SQLite at `${CLAUDE_PLUGIN_DATA}` (persists across updates) + per-project
  git-ignored cache; FTS5 for recall; Merkle index table.
- **Config:** `plugin.json` `userConfig` for options (module-depth for cones, TTL
  defaults, extractor set); sensitive values go to secure storage [S-DOC-PLUG].
- **Logging:** JSONL under the data dir (operations, freshness decisions, timings) — also
  the substrate for the benchmark.
- **Error handling:** every path degrades safely — no git → full sweep; corrupt cache →
  rebuild (version-gated); extractor failure → fall back to "unknown, must explore" rather
  than serving a guess.
- **Testing:** unit tests for hashing/cone/freshness; golden-repo fixtures (small, large,
  a Laravel sample, a Node sample); **adversarial stale-file tests** (edit mid-run, assert
  the fact is withheld); `claude plugin validate` + a `claude plugin eval` suite in CI.

### What we lean on natively (do NOT rebuild — from the native audit)
- Progressive disclosure of instructions → native skills [S-DOC-SKILL].
- MCP overhead reduction → native Tool Search [S-DOC-MCP].
- Cost/context reporting → native `/context`, `/usage`, `/skill-doctor` [S-DOC-COST].
- Context isolation for heavy side-work → native subagents [S-DOC-SUB].
- Note: native **auto-memory** overlaps "remember notes," but has **no input-change
  invalidation** and is machine-local [S-DOC-MEM] — that overlap is exactly what Keystone
  does differently, not something to duplicate.

## 5.5 Security & privacy (Phase 7) — core requirement

- **Secret exclusion:** scan content before any cache write; never store secrets/tokens/
  `.env`/credentials; redact if they appear in extractor output.
- **Local-first, no exfiltration:** MVP sends no source code anywhere; no external API, no
  embedding service, no telemetry. (V2 team-sync is opt-in, encrypted, findings-only,
  never raw source.)
- **Read-only by default:** Keystone analyses and writes only to its own cache. It never
  modifies project files or runs destructive commands. Any state-changing action (e.g. a
  `verify` that runs a test command) is explicit and shown first.
- **Cache isolation between projects:** per-repo keys; no cross-project bleed.
- **Safe FS access:** stay within the project root; don't follow symlinks out of it
  (record target string instead); treat generated/downloaded files as data.
- **Data retention/deletion:** a documented `keystone:forget` / purge; cache is git-ignored
  and user-deletable; supersede-chains can be compacted.
- **Dependency security:** minimal deps; pin versions; the plugin itself runs with the
  user's shell privileges, so we keep the attack surface small and the code auditable
  (the claude-remember "config-write redirects backup remote" issue [S-CR-REM] is the
  anti-pattern to avoid).

## 5.6 Benchmark & validation (Phase 8)

Full protocol from the token-economics research. Three arms: (A) no plugin, (B) plugin,
(C) plugin + caching enabled/warmed — but note caching is on by default in Claude Code
[S-DOC-CACHE], so C is really "measured caching-aware."

**Hold constant:** same Claude Code version, model, `/effort`, fast-mode, `ENABLE_TOOL_SEARCH`,
same repo @ same commit (clean tree), same CLAUDE.md/MCP/other skills. Only variable =
Keystone on/off. Fresh session per task; discard a warm-up run.

**Design:** 8-15 scripted realistic tasks with gradable correct outcomes; **interleave**
A,B,A,B (not blocked); ≥5 reps/task/arm; pre-register tasks + metrics.

**Measure (from the API `usage` object, not estimates):** input tokens; output tokens;
`cache_creation_input_tokens` and `cache_read_input_tokens` **separately**; effective cost
via the real multipliers; API calls; tool calls (reads/greps/MCP); distinct files
inspected; wall-clock; **accuracy** (graded); **stale-cache incidents**.

**Adversarial tasks (mandatory):** ≥2 tasks modify a file mid-session; a Keystone that
serves the old fact = **correctness failure**, not a saving. This is how we prove the
core claim.

**Project types:** small; large repo; legacy PHP; modern Laravel (the ERP); Node/TS;
multi-service.

**Report:** median + IQR, paired B−A per task, across all four axes, caching-aware,
correctness graded blind. A defensible claim names the task count, reps, controls, and
0 stale serves. Anything less stays labelled HYPOTHESIS. **Correctness is never traded for
token savings.**

## 5.7 MVP development roadmap (Phase 9.12)

> No code until you approve. This is the proposed sequence once you say go.

1. **Spike & de-risk (small):** verify the name is free; prototype `ks-hash` (Merkle +
   cone) and `ks-freshness` on the ERP repo; confirm the git and no-git paths. Decide
   xxh3 vs blake3. *Exit:* freshness engine correctly withholds a fact after a real edit.
2. **MVP build:** `map` + `note` + `recall` skills; SQLite store at `${CLAUDE_PLUGIN_DATA}`;
   SessionStart card; secret-scan guard; `plugin.json`. *Exit:* `claude plugin validate`
   passes; manual end-to-end on the ERP works.
3. **Harden:** error/degradation paths; per-project isolation; cache-size caps; logging.
4. **Benchmark (the proof gate):** run §5.6 on ≥3 project types incl. the ERP. *Exit:* a
   measured, caching-aware result + 0 stale serves on adversarial tasks. **If the measured
   benefit is marginal, we say so and reconsider — we don't ship a claim we can't back.**
5. **Package & docs:** honest README (capability-first, no borrowed %), `plugin eval`
   suite, install steps; optional marketplace submission.
6. **V1 iteration:** `verify`, impact query, global fingerprints, framework extractors.

**Risks to watch:** (a) native auto-memory / platform features closing the gap further —
mitigated by leading on the trust guarantee they don't provide; (b) cone extraction across
many languages is real work — start with Laravel/PHP + Node, make extractors pluggable;
(c) the benchmark may show modest efficiency — fine, because the *primary* pitch is
correctness/trust, which the adversarial tasks prove directly.
