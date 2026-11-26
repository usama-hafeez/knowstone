# 02 — Market, Ecosystem & Competitor Analysis

Covers brief Phase 1 (ecosystem), Phase 9.2 (market research), Phase 9.3 (competitors).

## 2.1 The ecosystem, briefly (CONFIRMED unless noted)

Claude Code plugins are distributed through marketplaces and curated lists:

- **Official marketplace** (`claude-plugins-official`) — added automatically on first
  interactive start; inclusion at Anthropic's discretion [S-DOC-MKT].
- **Community marketplace** (`claude-community`) — third-party plugins submitted to
  Anthropic [S-DOC-MKT].
- **Demo marketplace** (`claude-code-plugins`) — examples, added manually; one source
  calls it deprecated (LIKELY) [S-DOC-MKT].
- **Curated "awesome" lists and registries** — hesreallyhim/awesome-claude-code [S-AWE],
  ComposioHQ/awesome-claude-plugins [S-COMPO], and **davila7/claude-code-templates**
  (34,217★ live), a CLI/registry that installs components rather than a runtime tool
  [S-TMPL].

**Adoption-signal caveat (important).** Across the ecosystem, "popularity" is almost
always GitHub stars or blog mentions, not installs or retention. Stars measure
discovery interest, not daily use. `claude-code-templates` has 579 open issues against
34k stars [S-TMPL]; SuperClaude has 24k stars but its last push was ~2 months ago
[S-SC]. Treat all star counts as **LIKELY** directional interest, not proven adoption.

## 2.2 Competitor table (24 tools)

Stars are **live** reads from `api.github.com` on 26 Nov 2026 unless marked. Grouped by
what they actually do. The column that matters most for us is **"Hash-bound freshness?"**
— does the tool refuse to serve a stored fact once its underlying code changed?

### A. Persistent memory (cross-session knowledge)

| Tool | Stars | Mechanism | Hash-bound freshness? | Key limitation |
|------|------:|-----------|----------------------|----------------|
| **claude-mem** [S-CM] | 119,834 | hooks + MCP + skill + CLI (hybrid) | **No** — SQLite + Chroma vectors, no git/file-hash gate | Injects summaries from 2nd session on; can pollute context; 110 open issues |
| **claude-remember** [S-CR-REM] | 215 | hooks (SessionStart injects) + `/remember` | **No** — path-associated, Haiku-compressed logs | Non-OSS licence; always-on injection; a config-write could redirect its git backup remote (exfil risk) |
| **SuperClaude** [S-SC] | 23,948 | config/instruction injection, 30 cmds + 20 agents | **No** | Always-on context load; stale (~2 mo); claims "30-50% savings" with no method |

### B. Codebase index / semantic search (structure retrieval)

| Tool | Stars | Mechanism | Hash-bound freshness? | Key limitation |
|------|------:|-----------|----------------------|----------------|
| **Serena** [S-SERENA] | 31,716 | MCP server (LSP, symbol-level) | Partial — has a "memory system," storage/invalidation undocumented | GPL-3.0 whole-work; always-on MCP (though basic tools auto-disabled inside Claude Code); 152 open issues |
| **Claude Context** [S-CC] | 12,730 | MCP server + Milvus/Zilliz vectors | **Re-index only** — "re-index only changed files using **Merkle trees**" (not fact-gating) | Needs external vector DB + embedding API keys; "~40% token reduction" eval (one of the few real controlled numbers) |
| **codebase-index** (denfry) [S-CBI] | 14 | CLI + skill + MCP(11 tools) + optional hook | **No** — reports freshness as *uncertainty*, does not refuse stale | Self-contradicting version in README; within-session evidence memory only |
| **codeindex** (munhq) [S-CIDX] | 3 | Zig code-intel engine (tree-sitter, trigram) | Undocumented | Tiny; unclear Claude Code integration |
| **CodeTree** (npm) [S-CT] | n/a | MCP + hooks + CLI | Hints (chokidar + xxhash) but **undocumented** | Non-OSI licence; no public repo link — LIKELY |
| **ThinkyMiner/codeTree** | 30 | MCP (tree-sitter, 23 tools) | Undocumented | Name collision with the npm one |

### C. Documentation into context

| Tool | Stars | Mechanism | Notes |
|------|------:|-----------|-------|
| **Context7** [S-C7] | 65,486 | MCP **or** CLI+Skills ("no-MCP" mode) | Hosted service; sends library queries off-box; for library docs, not your repo |

### D. Review / security (adjacent, not our space)

| Tool | Mechanism | Notes |
|------|-----------|-------|
| **Native `/code-review`** [S-DOC-CR] | plugin: dispatches reviewers, confidence-scored | Reviews a diff without the GitHub App |
| **Native hosted Code Review** | GitHub App, inline PR comments | Launched Mar 2026 |
| **Native `/security-review`** | skill | Ships with Claude Code |
| **CodeRabbit plugin** [S-CRAB] | runs CodeRabbit CLI from inside Claude Code | Multi-platform hosted review |

### E. The freshness-binding micro-category (our actual competitors)

These are the only tools that already do the core mechanism Keystone is built on —
stamp a fact with a hash and refuse/hide it when the code changes.

| Tool | Stars | Freshness model | Gap vs Keystone |
|------|------:|-----------------|-----------------|
| **Kage** [S-KAGE] | 41 | whole-file hash + symbol anchors; withholds on change; "never act on stale knowledge" | Generic memory items, not verified decisions as a type; GPL-3.0; ~3 mo stale |
| **QuintinBotes/memory** [S-QB] | 0 | path + line-range + **hash of cited text**; goes stale & hides when citation breaks | **Auto-restores** when hash re-matches (no forced human re-verify); generic items; 0 adoption |
| **VRM** [S-VRM] | UNKNOWN | hashed snippet in `memories.json`; re-checks on recall, marks STALE/MISSING + TTL | Early (<0.2 npm); repo wouldn't resolve; generic items — LIKELY |

### F. Distribution / tooling (not runtime competitors)

| Tool | Stars | What it is |
|------|------:|-----------|
| **claude-code-templates** (davila7) [S-TMPL] | 34,217 | component registry/installer |

**Also found, not deep-verified** (candidates if we want more): conarylabs/mira (Rust
MCP, Merkle re-index — repo 404 on 26 Nov, UNCONFIRMED), kunickiaj/codemem,
ErebusEnigma/context-memory, codenamev/claude_memory (staleness by *time unused*, not
code change), memory-arborist (content-hash-gated MEMORY.md cleanup).

## 2.3 What the table tells us

1. **The popular tools don't guard freshness.** The four biggest relevant projects
   (claude-mem 120k, Context7 65k, Serena 32k, Claude Context 13k) either don't bind
   facts to evidence at all, or use hashing only to *re-index*, never to *refuse a stale
   claim*. That is a genuine design gap at the top of the market.
2. **The tools that do guard freshness have no adoption and a weaker trust model.**
   Kage/QuintinBotes/VRM total <60 stars combined, two auto-restore rather than forcing
   re-verification, and none treats *verified engineering decisions* (root causes, ADRs)
   as first-class. So the niche is **occupied but unowned**.
3. **Heavy-MCP is the norm and it's a liability.** Most index/search tools run an
   always-on MCP server (idle tool-schema cost every turn) and several need external
   infra (Milvus, embedding keys). A lean, local-first, mostly-skills design is a real
   differentiator — *provided* we measure against Tool Search, which already defers MCP
   schemas by default (see file 04).
4. **Licences matter if we borrow.** Serena (GPL-3.0 whole-work) and claude-remember
   (non-OSS) can't be copied into a permissively-licensed plugin. Assay's research code
   and the Cursor write-up are reference-only. We build clean-room.

Next: `03-pain-points-and-gap-analysis.md` ranks the pains behind this and scores the
opportunity.
