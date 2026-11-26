# 01 — Executive Summary

## The one-line answer

Build a **local-first, verify-first codebase memory for Claude Code** that caches
*provenance-stamped* project knowledge (structure, schema, routes, conventions,
solved-bug root causes) and **refuses to serve any fact once the inputs it was
derived from have changed**. Working name: **Keystone** (name not yet checked for
clashes — HYPOTHESIS).

It is deliberately **not** another always-on memory logger, not another heavy MCP
semantic-search server, and not another code-review plugin. The differentiator is
**freshness you can trust**: every cached fact carries the git/file hash it was
verified against, and stale facts are flagged for re-verification instead of being
re-served. That is the exact failure mode the big incumbent (claude-mem) does not
guard against, and it maps directly onto your own house rule: *never present
anything you have not verified.*

> **Reality check (added after deep research — correcting an earlier overclaim):**
> The freshness-binding *mechanism* is **not novel**. Three shipping projects already
> hash-stamp a fact to its evidence and refuse to serve it when code changes —
> **Kage** (41 stars, GPL-3.0, ~3 months stale), **QuintinBotes/memory** (0 stars,
> MIT, active), and **VRM** (early npm, LIKELY). None is established, none treats
> **human-verified bug root causes / architectural decisions** as a first-class
> object, and the closest ones **auto-restore** a fact when the hash re-matches
> rather than **forcing fresh human re-verification**. The big popular tools
> (claude-mem 119,834 stars live, Context7 65k, Serena 32k) do none of it.
> So this is an **execution + stricter-trust-model** play in a barely-occupied niche,
> **not** a first-mover play. Positioned honestly throughout the rest of this report.

## Why this, and why now (evidence, not opinion)

Three findings line up into one gap:

1. **Token waste from re-exploration is real and widely felt.** Multiple independent
   developer write-ups report that a large share of file reads in a session are
   re-reads of files already loaded, and that CLAUDE.md is re-sent on every tool
   call. Self-reported figures range from ~37% to ~71% of reads being redundant
   [S23][S24][S25]. Anthropic itself acknowledged users hitting usage limits far
   faster than expected [S4]. *Direction: LIKELY. Exact %: HYPOTHESIS.*

2. **The market has split the problem into three half-solutions.**
   - *Persistent memory* — claude-mem (~94k stars, LIKELY) [S9] logs tool activity
     to SQLite and **re-injects it into every new session** [S8]. It persists, but
     it injects always-on (context-pollution risk) and has weak input-change
     invalidation.
   - *Codebase maps / semantic search* — Serena [S15], Claude Context [S14],
     CodeTree [S12], codebase-index [S11], codeindex [S13]. These reduce re-reading
     but most run an **MCP server** (high always-on token overhead: cited 18k-55k
     tokens [S17]) and index *code structure* without persisting *human-verified
     decisions*.
   - *Docs cache* — Context7 (~60k stars, LIKELY) [S16]: great for library docs,
     again via MCP.

   **No single lightweight, local-first tool does structure + verified-decision
   memory + strict freshness together.** (Gap — see `03-pain-points...`, scored.)

3. **The hard, unsolved part is invalidation, and there is proven prior art to
   borrow.** Cursor and several indexers use Merkle trees / git-diff / mtime+hash
   two-tier checks to re-index only what changed [S31][S32]. The incumbents in
   Claude Code land mostly *re-index on a schedule or on session start*; few bind a
   *persisted fact* to the *hash of its evidence*. That binding is the product.

## What makes it defensible (the three differentiators)

1. **Provenance-stamped facts with hard invalidation.** Each cached fact stores the
   hashes of the files/schema it was derived from. Retrieval checks freshness first;
   stale → flagged, not served. "Do not trust stale information" becomes a guarantee,
   not a hope.
2. **Progressive disclosure by default.** Always-on footprint is a tiny (<500 token)
   project "card". Everything heavier is pulled **on demand** via skills + local
   scripts, so the plugin costs almost nothing when idle — the opposite of a
   framework that front-loads 30 commands and 19 agents [S33].
3. **Local-first, script-deterministic, minimal/no MCP.** Deterministic work
   (hashing, structure extraction, schema dump) is done by scripts, not by burning
   model tokens, and results are reused. No source code leaves the machine.

## MVP at a glance (full scope in file 05)

- **Project card** (SessionStart, tiny): one-paragraph "what this repo is", entry
  points, stack, where the cache lives. Progressive-disclosure pointer only.
- **`keystone:map`** skill: deterministic script builds/refreshes a structural index
  (dirs, modules, entry points, routes, DB schema, test layout) into a local,
  git-ignored store keyed by `git HEAD + file hashes`.
- **`keystone:recall`** skill: query previously verified findings (bug root causes,
  decisions, conventions), each provenance-stamped; stale ones surfaced as "needs
  re-check", never served as current fact.
- **`keystone:note`** skill: record a verified finding with its evidence hashes.
- **Invalidation engine**: mtime+size fast path, content hash on miss, git-HEAD and
  schema-hash checks. Partial (per-file) and project-wide invalidation.
- **Security**: secret-scan before any write; never cache secrets/tokens/.env;
  per-project isolated cache; read-only analysis by default.

Stack-agnostic from day one (PHP/Laravel, Symfony, Node/TS, Python, Go, MySQL,
PostgreSQL). A real-world Laravel ERP is the ideal first test bed.

## What I am explicitly NOT recommending

- Not a semantic/embeddings index for MVP (heavier, MCP-ish, invalidation harder,
  and Serena/Claude-Context already occupy it). Possible V2.
- Not a code-review or security-scanner plugin — native `/code-review` and
  `/security-review` plus CodeRabbit already cover it well [S29][S30].
- Not an always-on MCP server for MVP — overhead is the thing we are trying to cut.

## Decision you are approving

1. The concept (**Keystone**: verify-first codebase memory).
2. The MVP scope above.
3. "Research-first, build-after-approval" — I stop here until you say go.

See `03` for the scored opportunity matrix that ranks this against four alternatives,
and `05` for the full architecture, security model and benchmark plan.
