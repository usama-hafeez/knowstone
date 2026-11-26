# 03 — Developer Pain Points & Market-Gap Analysis

Covers brief Phase 1.3 (pain research), Phase 2 (gaps/opportunities), Phase 9.4, 9.5.

## 3.1 Pain points, ranked by strength of real evidence

From deep research across GitHub issues, HN, Reddit write-ups and dev.to. Ranked by how
much **independent, credible** evidence exists, not by how loud the blogs are. Honest
caveat up front: a large share of online "evidence" is self-reported blog/vendor content,
not controlled data.

| Rank | Pain | Evidence | Confidence | Verification |
|------|------|----------|------------|--------------|
| 1 | Token burn / hitting usage limits | STRONG | LIKELY | **Anthropic publicly acknowledged it** [S-DEVCLASS]; postmortem traced part to a harness bug [S-SWILL] |
| 2 | Memory loss between sessions | STRONG | LIKELY | GitHub #14227 (primary); huge tool cottage-industry [S-GH14227] |
| 3 | CLAUDE.md instructions *ignored* | STRONG | LIKELY | GitHub #2544/#17530 + heavy dev.to volume [S-GH2544] |
| 4 | MCP tool-definition bloat | STRONG | LIKELY | GitHub #23787: ~25k tok / ~53% of initial context in a 3-server setup [S-MCP23787]; Anthropic eng blog [S-ENG-MCP] |
| 5 | Re-reading the same files | MOD→STRONG | LIKELY | GitHub #11487; self-measured 107-session replay: one file read **189×** [S-GH11487][S-EGOR] |
| 6 | Context overhead before work starts | MODERATE | LIKELY (mechanism) | Docs confirm always-loaded prefix [S-DOC-CTX]; felt via #1/#4, not its own grievance |
| 7 | Debugging symptom vs root cause | MODERATE | LIKELY | claudeissues #45041/#47236 + HN; anecdotal |
| 8 | Understanding legacy/unfamiliar code | MODERATE | LIKELY | Fowler/JetBrains; an *opportunity* more than a loud grievance [S-FOWLER][S-JB-LEGACY][S-ONBOARD] |
| 9 | Repeated doc lookups / stale APIs | WEAK→MOD | HYPOTHESIS | Mostly Context7/Mintlify vendor content — demand partly manufactured |
| 10 | Subagent orchestration clumsy | WEAK | HYPOTHESIS | Only how-to content; little real outcry |

### Two corrections to my own first-pass framing (per verify-first)

- **"71% of reads are redundant"** — I used a ~37-71% range earlier. The 71% figure
  could **not** be traced to a primary source and is dropped. The solid number is one
  author's 107-session replay (one file read 189×, ~8% of tokens estimated recoverable)
  [S-EGOR] — a single self-measured dataset, so **HYPOTHESIS**, not fact.
- **"Stale CLAUDE.md drift"** — weakly evidenced as a *distinct* pain. The well-supported
  complaint is CLAUDE.md being **ignored** (rank 3), which is a different problem we are
  **not** solving. Corrected.

### The load-bearing caveat for the whole project

The top pains (1, 2, 4, 5) are all **shrinking targets** — Anthropic is actively shipping
native fixes: auto-memory (file 05 / [S-DOC-MEM]), Tool Search deferring MCP schemas by
default [S-DOC-MCP], and the April-2026 harness-bug fixes [S-SWILL]. **A plugin must aim
at the gap the native fixes leave, not the raw 2026 complaint.** This is precisely why
Keystone targets *freshness/trust* (what auto-memory does **not** do) rather than
"remember things" or "save tokens on re-reads" (which native features increasingly cover).

## 3.2 Opportunity matrix (scored /10)

Each opportunity scored on the brief's criteria. Scores are my **reasoned judgement**
(HYPOTHESIS-level), grounded in the evidence above — not measured facts. Higher = better
opportunity. "Comp. weakness" = how poorly existing tools serve it (higher = more open).

| # | Opportunity | Severity | Frequency | Comp. weakness | Time save | Token save* | Low build | Low maint. | Adoption | **Total /80** |
|---|-------------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| O1 | **Verify-first freshness ledger** (verified decisions/root-causes, forced re-verify) | 7 | 6 | 8 | 7 | 4 | 6 | 6 | 6 | **50** |
| O2 | Local structural codebase map + cache (stop re-exploring) | 6 | 8 | 5 | 7 | 5 | 5 | 5 | 7 | **48** |
| O3 | Cross-machine / team-shared verified memory | 6 | 5 | 8 | 6 | 3 | 4 | 4 | 6 | **42** |
| O4 | Token/context "honest meter" (what's loaded, what it really costs) | 5 | 6 | 5 | 4 | 3 | 7 | 7 | 5 | **42** |
| O5 | Generic cross-session memory logger | 7 | 8 | 2 | 6 | 4 | 4 | 4 | 5 | **40** |

*Token save is scored **low across the board on purpose**: prompt caching means most
"re-sent tokens" are billed at 0.1×, so raw token savings are smaller in dollars than in
count (file 04). We refuse to inflate this axis.

### Reading the matrix

- **Five high-value opportunities:** O1-O5 above (all ≥40/80).
- **Three that could be unique differentiators:** **O1** (forced re-verification trust
  model — no incumbent does it), **O3** (team/cross-machine verified memory — auto-memory
  is explicitly machine-local [S-DOC-MEM], and the big tools don't verify), and the
  **fusion of O1+O2** (a map whose facts carry provenance — nobody pairs structural
  caching with refuse-stale verified decisions).
- **One strongest overall concept:** **O1, repositioned** — the verify-first freshness
  ledger, with O2 (structural map) as the substrate that produces cacheable facts, and a
  clear path to O3 later. This is the Keystone recommendation.

### Why not the higher-frequency O2/O5 as the lead?

- **O5 (generic memory):** highest frequency, but comp. weakness is 2/10 — claude-mem
  (120k) owns it and native auto-memory now overlaps it. Building here is fighting the
  strongest incumbent *and* the platform. Rejected as a lead.
- **O2 (structural map):** great substrate, but on its own it's a crowded field (Serena,
  Claude Context, codebase-index) and its headline benefit (token saving) is the weakest
  axis once caching is understood. Best used as Keystone's *engine*, not its *pitch*.

O1 wins because it has the **highest competitive weakness (most open)** combined with
real severity, and it's the only option whose core value (trust/correctness) is **not**
undermined by the caching reality or by Anthropic's native roadmap.

## 3.3 The gap, stated precisely

> **No established, lean, local-first Claude Code plugin persists human-verified
> engineering knowledge — bug root causes, architectural decisions, conventions — as
> first-class objects, each bound to the hash of the evidence it was derived from, and
> *forces fresh human re-verification* when that evidence changes instead of silently
> re-serving or auto-restoring it.**

- The popular tools (claude-mem, Serena, Context7, Claude Context) don't bind facts to
  evidence at all, or only to re-index.
- The three tools that do bind (Kage, QuintinBotes, VRM) are unadopted, treat generic
  memory items rather than verified decisions, and mostly auto-restore rather than
  force re-verification.
- Native auto-memory stores notes but has **no input-change invalidation** and is
  machine-local.

That precise sentence is the product. File 04 is how we make the freshness guarantee
real; file 05 is the product, architecture, security and proof plan.
