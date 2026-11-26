# 04 — Caching Architecture & Token-Optimisation Strategy

Covers brief Phase 3 (caching, all sub-parts) and Phase 9.6. This is the technical heart
of the product. It has two halves: **(1) the caching/invalidation architecture** (how we
make "freshness you can trust" real) and **(2) the honest token model** (what we can and
cannot claim).

---

## PART 1 — Caching & invalidation architecture

### 1.1 What we cache (two tiers, different rules)

**Tier A — Derived facts** (machine-produced, cheap to recompute, safe to auto-refresh):
project structure, directory inventory, module/import graph, entry points, route/endpoint
inventory, DB schema shape, config structure, test layout.

**Tier B — Verified findings** (human- or test-confirmed, expensive to recreate, the
product's crown jewels): bug root causes, architectural decisions (ADRs), project
conventions, "known limitations," "this looks wrong but is intentional because…". These
are the first-class objects no incumbent treats specially.

Explicitly **never cached:** secrets, tokens, `.env` contents, credentials, anything a
secret-scan flags (file 05 §security).

### 1.2 Where it's stored

- **Location:** `${CLAUDE_PLUGIN_DATA}` (persists across plugin updates, per Anthropic's
  manifest docs [S-DOC-PLUG]) for the plugin's own store; a project-scoped cache under
  the project (git-ignored) keyed to the repo. Per-project isolation is mandatory.
- **Format:** local **SQLite** (zero-infra, transactional, FTS5 for text search) for both
  tiers, plus the Merkle index. No external vector DB, no embedding API (unlike Claude
  Context/Serena) for the MVP — local-first and key-free.
- **Rationale:** every heavy incumbent that needs Milvus/Zilliz + embedding keys adds
  setup friction and sends data off-box. SQLite keeps it local, private and installable
  in one step.

### 1.3 How it's indexed (the Merkle spine) — borrowed from proven prior art

From Cursor [S-CURSOR] and the Assay paper [S-ASSAY]:

- Per file, store `{ path, mtime, size, content_hash }` (content hash = xxh3_64 or
  blake3 — fast, non-cryptographic is fine for change detection).
- Fold file hashes into directory hashes up to a root → a **Merkle tree**. An edit changes
  only that file's hash and its ancestors', so detecting "what changed" walks only
  divergent branches (Cursor: a 50k-file tree of names+hashes ≈ 3.2 MB).
- Keep a `path → content_hash` map so **renames/deletes** are caught by absence, and
  content-keyed derived work is reused automatically on a rename.

### 1.4 The provenance binding (the differentiator) — Assay's "dependency cone"

The Assay paper [S-ASSAY] is the blueprint and independent validation of the whole idea:

- A fact's subject is a **module** (a directory up to a configured depth), not a single
  file. Its **dependency cone** = the module plus everything reachable via import edges;
  the **cone hash** folds the module content-hashes in reverse-topological order over the
  import DAG (cycles collapsed into components, each hashed once).
- A **verified finding** is stored as a claim-style record:
  ```
  { id, predicate, subject_modules[], scope∈{self,cone,repo},
    bindings{ module → cone_hash at verify time },
    global_bindings{ lockfile_hash, schema_hash, tool_version },
    evidence{ what was checked: command, exit code, output hash, test count },
    verified_by, verified_at, ttl, supersedes }
  ```
- **Why the cone, not the file or the repo:** Assay measured it — cone-binding
  re-verifies only ~8-82% of claims on a change (vs 100% for naive repo-binding), while
  per-file binding **misses 23-68%** of the invalidations it should catch (because it
  ignores transitive imports). The cone is the sound minimum.

### 1.5 How it's retrieved & when it's invalidated (cheapest-first check order)

On every retrieval, run checks in this order and **stop at the first failure** → mark
**stale, do not serve**:

1. **tool_version / cache-format** mismatch → whole cache invalid, rebuild (indxr pattern
   [S-INDXR]: version the schema so a plugin/framework upgrade forces a rebuild).
2. **TTL** expired → stale (backstop for *external* drift a hash can't see — a live DB's
   data, an upstream API). Short TTL for externally-coupled facts, effectively infinite
   for pure code-derived facts that have a content binding.
3. **Global binding** changed — `lockfile_hash` (deps), `schema_hash` (DB), `config_hash`
   (framework/build) that this fact depends on → stale.
4. **Git fast path** (if `.git` present): `HEAD == last_indexed_commit` and tree clean →
   skip to serve; else `git diff last_commit..HEAD` + staged/unstaged/untracked for
   candidate changed files (cartog pattern [S-CARTOG]).
5. **mtime + size** fast path on candidate files (indxr): unchanged → serve.
6. mtime/size differ → compute **content hash**, recompute the **cone hash**, compare to
   the stored binding (Assay freshness: fresh iff binding == current for *all* subjects).
   Match → serve (a touched-but-unmodified file); mismatch → **stale**.

Two degradation paths are mandatory: **no git** (local-first users, and this very project
dir is not a git repo) falls back to the full stat+hash Merkle sweep; **mtime lies** (the
reason every serious indexer keeps a content-hash tie-breaker) means mtime only decides
*whether to bother hashing*, never whether to *serve*.

### 1.6 How freshness is verified / the never-delete rule

- **Status is derived on read, never stored** (Assay) — so the "stale" flag can't itself
  go stale. A fact whose binding no longer matches is simply **not served**; it's surfaced
  as "stale — needs re-verification."
- **Nothing is deleted.** Re-verification **appends** a new record that `supersedes` the
  old; the audit trail is kept. Human findings are expensive to recreate.
- **Forced re-verification (our stricter trust model, the differentiator vs
  Kage/QuintinBotes/VRM):** when inputs change, a Tier-B fact does **not** auto-restore if
  the hash later re-matches. It stays "needs re-confirmation" until a human (or a defined
  test predicate) re-attests. Assay's **evidence-monotonicity** idea reinforces this: don't
  let a re-verify silently drop a previously-recorded failing check — that stops an agent
  "fixing" a finding by forgetting it.

### 1.7 Partial vs project-wide invalidation

- **Default: partial** (per-cone, per-file) — one package's change doesn't nuke the repo.
- **Project-wide** only for *global inputs*: lockfile, schema dump, framework major,
  cache-format version.
- **Hard cases:** deletions/renames via the path→hash map; dependency changes via
  lockfile hash; schema changes via a normalised schema-dump hash; **generated/binary
  files** bind to their *generator input* (the `.proto`, the migration) not the output, so
  they don't thrash the cache; **symlinks** recorded as link-target strings (don't follow,
  to avoid cycles and leaking content outside the repo root).

### 1.8 Security & privacy implications (summary; full in file 05)

Local-first and key-free means **no source code leaves the machine** by default. Secret
scan before any write. Per-project cache isolation. Cache files git-ignored. Read-only
analysis by default; writes to the cache only, never to project files without approval.

### 1.9 Cache-size management

- Tier A is bounded by repo size and regenerable → cap with LRU + a size ceiling; evict
  freely (it rebuilds).
- Tier B is small (human-scale: tens to low-hundreds of findings) and precious → never
  auto-evict; supersede-chains compacted, not dropped.
- Merkle index is the biggest Tier-A artefact; Cursor's 3.2 MB / 50k files is the scale
  reference — trivial on disk.

---

## PART 2 — The honest token model (what we can and cannot claim)

This section exists so we never claim a saving we haven't measured. It is the single most
important honesty lever in the whole project.

### 2.1 Prompt caching changes everything (CONFIRMED from Anthropic docs [S-DOC-CACHE])

- Claude Code manages the prompt cache automatically; 1-hour TTL on a subscription,
  5-min on an API key by default [S-BLOG-MAX].
- **Cache read = 0.1× input price** (even lower on some models: Opus/Sonnet 5.5 at
  0.05×). Cache write = 1.25× (5-min) or 2× (1-hour).
- The cache is a strict **prefix** over `tools → system → messages`. A change at any level
  invalidates that level **and everything after it**. Modifying *any* tool definition
  invalidates the **entire** cache.

**Consequence:** a file read into context is re-sent every turn, but after the first
(cache-write) turn those re-sends bill at **0.1×**. So the popular blog arithmetic — "we
blocked 19 re-reads × 2,000 tokens = saved 38,000 tokens" — is **mostly wrong**: those
re-sends were already discounted ~90%. A 2,000-token file over 10 turns costs ≈ 2,000
(write) + 9×200 (reads) ≈ 3,800 effective tokens, not 20,000.

### 2.2 The four axes (never conflate them)

| Axis | What it means | Does Keystone help? |
|------|---------------|---------------------|
| (a) **Input tokens** | tokens fed per request | Weakly — and much is already 0.1× cached. **Do not lead with this.** |
| (b) **Tool executions** | how often a tool runs | Yes — answer from the cache instead of re-grepping/re-exploring; but adds a small check cost and a staleness risk we must guard |
| (c) **API calls (round-trips)** | request/response cycles | **Yes, the real win** — fewer exploration turns ⇒ fewer calls ⇒ fewer *output* tokens (output ≈ 5× input price) |
| (d) **Latency (wall-clock)** | time to finish | Mixed — fewer round-trips helps; a synchronous hook or extra lookup can hurt. Measure it. |

### 2.3 What we are allowed to claim

- **Primary claim: trust/correctness.** "Keystone won't let Claude act on a fact whose
  code has changed." This is a *capability*, provable by the adversarial stale-file
  benchmark (file 05), not a percentage.
- **Secondary claim (only after we measure it): fewer round-trips / less re-exploration.**
  Phrased as a measured median with an interval, from the file-05 protocol, on the user's
  actual Claude Code version — never a borrowed blog %.
- **What we will NOT claim:** any headline "saves X% tokens." Every circulating figure
  (40/60-90/71/63%) is HYPOTHESIS — none rests on a controlled with/without test with
  correctness checks [S-READONCE][S-EGOR][S-KEN-MCP]. We don't add to the noise.

### 2.4 Genuine, defensible efficiency levers (these are real)

1. **Avoid cache-busting.** Don't reorder/add/remove MCP servers mid-session; keep any
   injected context static (no timestamps/per-session paths that bust the prefix every
   turn) [S-DOC-CACHE][S-BLOG-MAX]. Keystone's always-on footprint must be tiny *and*
   static.
2. **Cut novel exploration.** When the agent would otherwise grep/read its way to
   re-derive the module graph or schema, serve the verified fact in one shot → fewer
   round-trips and fewer *output* tokens.
3. **Deterministic work in scripts, not tokens.** Hashing, structure extraction and schema
   dumps run as local scripts; the model consumes a concise result, not the raw tool
   output [S-DOC-SUB gives the subagent pattern; scripts are executed, not loaded,
   S-DOC-SKILL].
4. **Respect Tool Search.** MCP overhead is already deferred by default [S-DOC-MCP], so a
   mostly-skills design avoids adding to idle cost rather than pretending to "fix" MCP.

### 2.5 Measurement, not assertion

Every efficiency statement in Keystone's docs must trace to the file-05 benchmark run on a
defined task battery, reported across all four axes, caching-aware, with the adversarial
stale-file tasks where **serving stale content counts as a correctness failure, not a
saving**. Until then, the only honest word is "unmeasured."
