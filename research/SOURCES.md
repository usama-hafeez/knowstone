# Sources

All URLs accessed **26 Nov 2026** unless noted. Confidence labels are applied where
each source is used in the body. GitHub star counts marked **live** were read from
`api.github.com` on 26 Nov 2026 by the competitor-research agent; others are secondary
snapshots and are labelled LIKELY.

## Official Claude Code docs (CONFIRMED)
- [S-DOC-MEM] Memory — https://code.claude.com/docs/en/memory.md
- [S-DOC-SKILL] Skills — https://code.claude.com/docs/en/skills.md
- [S-DOC-SUB] Subagents — https://code.claude.com/docs/en/sub-agents.md
- [S-DOC-MCP] MCP / Tool Search — https://code.claude.com/docs/en/mcp.md ; Agent SDK tool-search — https://code.claude.com/docs/en/agent-sdk/tool-search
- [S-DOC-HOOKS] Hooks reference — https://code.claude.com/docs/en/hooks.md ; guide — https://code.claude.com/docs/en/hooks-guide.md
- [S-DOC-PLUG] Plugin components — https://code.claude.com/docs/en/plugins/components.md ; manifest — https://code.claude.com/docs/en/plugins/manifest-reference.md ; marketplace — https://code.claude.com/docs/en/plugins/marketplace-reference.md
- [S-DOC-CTX] Context window — https://code.claude.com/docs/en/context-window.md
- [S-DOC-COST] Costs — https://code.claude.com/docs/en/costs.md ; Commands — https://code.claude.com/docs/en/commands.md
- [S-DOC-TOOLS] Tools reference — https://code.claude.com/docs/en/tools-reference.md
- [S-DOC-MKT] Anthropic plugin marketplaces — https://code.claude.com/docs/en/plugins/anthropic-marketplaces ; Discover plugins — https://code.claude.com/docs/en/discover-plugins
- [S-DOC-CACHE] Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- [S-DOC-CR] Code review — https://code.claude.com/docs/en/code-review.md
- [S-BLOG-MAX] Anthropic, "Maximizing the value of your Claude Code sessions" — https://claude.com/blog/maximizing-the-value-of-your-claude-code-sessions
- [S-ENG-MCP] Anthropic engineering, "Code execution with MCP" — https://www.anthropic.com/engineering/code-execution-with-mcp

## Competitors (stars live 26 Nov 2026 via api.github.com unless noted)
- [S-CM] claude-mem — https://github.com/thedotmack/claude-mem — 119,834★ live, Apache-2.0, active
- [S-SERENA] Serena — https://github.com/oraios/serena — 31,716★ live, GPL-3.0 (whole work)
- [S-C7] Context7 — https://github.com/upstash/context7 — 65,486★ live, MIT
- [S-CC] Claude Context — https://github.com/zilliztech/claude-context — 12,730★ live, MIT ("~40% token reduction" eval)
- [S-CT] CodeTree — npm `codetree-claude` v1.7.9 (repo link blank; non-OSI licence) — LIKELY
- [S-CBI] codebase-index — https://github.com/denfry/codebase-index — 14★ live, MIT
- [S-CIDX] codeindex — https://github.com/munhq/codeindex — 3★ live, MIT
- [S-CR-REM] claude-remember — https://github.com/Digital-Process-Tools/claude-remember — 215★ live, NOASSERTION (source-available, non-OSS)
- [S-SC] SuperClaude — https://github.com/SuperClaude-Org/SuperClaude_Framework — 23,948★ live, MIT, last push 27 Sep 2026
- [S-TMPL] claude-code-templates — https://github.com/davila7/claude-code-templates — 34,217★ live, MIT
- [S-KAGE] Kage — https://github.com/kage-core/Kage — 41★ live, GPL-3.0, last push 29 Aug 2026 ("never act on stale knowledge")
- [S-QB] QuintinBotes/memory — https://github.com/QuintinBotes/memory — 0★ live, MIT, active (path+line+hash anchoring, hides on break)
- [S-VRM] Verified Repo Memory (VRM) — npm `@cognitivemyriad/vrm-local` v0.1.x (GitHub repo 404 on 26 Nov) — LIKELY
- [S-CRAB] CodeRabbit Claude Code plugin — https://claude.com/marketplace/plugins/coderabbit ; docs https://docs.coderabbit.ai/cli/claude-code-integration

## Caching / invalidation prior art
- [S-CURSOR] Cursor, "Secure codebase indexing" (Merkle trees) — https://cursor.com/blog/secure-codebase-indexing (publish date UNKNOWN)
- [S-ASSAY] "Assay: Claims That Decay With the Code" — https://arxiv.org/abs/2609.36170 (full text https://arxiv.org/html/2609.36170v1 ; code github.com/OmShiv/assay-research) — Sept 2026
- [S-CINM] "Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent" — https://arxiv.org/pdf/2606.22417 — June 2026
- [S-INDXR] indxr caching docs — https://docs.rs/crate/indxr/0.4.0/source/docs/caching.md
- [S-CARTOG] cartog indexer — https://docs.rs/crate/cartog/0.8.1/source/src/indexer.rs
- [S-AGIT] agit incremental search — https://docs.rs/crate/agit/latest/source/src/search/incremental.rs

## Token economics (MEASURED / VENDOR-STATED / ANECDOTE as labelled in body)
- [S-SDK-TS] Anthropic Agent SDK tool-search ("50 tools ≈ 10-20K tokens") — https://code.claude.com/docs/en/agent-sdk/tool-search
- [S-MCP23787] GitHub issue #23787, MCP tool schemas load upfront (~25k tok / ~53% in a 3-server setup) — https://github.com/anthropics/claude-code/issues/23787
- [S-UNBL] Unblocked, "MCP token budget autopsy" — https://getunblocked.com/blog/mcp-token-budget-autopsy/ (2026-05-14)
- [S-KEN-MCP] kenimo49, "Your MCP server eats 55,000 tokens…" (ESTIMATE) — https://dev.to/kenimo49/your-mcp-server-eats-55000-tokens-before-your-agent-says-a-word-i-measured-the-real-cost-19l8
- [S-KEN-SKILL] kenimo49, "Skills cost tokens even when they don't fire" (MEASURED, single session) — https://dev.to/kenimo49/claude-code-skills-cost-tokens-even-when-they-dont-fire-i-measured-5-skills-across-7-hours-the-8jo
- [S-READONCE] boucle2026, "Read-once hook" (40%, ANECDOTE) — https://dev.to/boucle2026/read-once-a-claude-code-hook-that-stops-redundant-file-reads-4bjk
- [S-EGOR] Egor Fedorov, claude-context-optimizer (107 sessions; now shows modeled levers) — https://egorfedorov.github.io/claude-context-optimizer/ and https://dev.to/egorfedorov/update-my-claude-code-token-optimizer-now-blocks-redundant-reads-heres-the-data-from-107-27lj

## Pain-point evidence (primary issues/threads)
- [S-DEVCLASS] DevClass, Anthropic admits faster-than-expected usage limits — https://www.devclass.com/ai-ml/2026/04/01/anthropic-admits-claude-code-users-hitting-usage-limits-way-faster-than-expected/5213575
- [S-SWILL] Simon Willison, recent Claude Code quality reports (postmortem) — https://simonwillison.net/2026/apr/24/recent-claude-code-quality-reports/
- [S-GH14227] GitHub #14227, "Persistent Memory Between Sessions" (closed not-planned) — https://github.com/anthropics/claude-code/issues/14227
- [S-GH2544] GitHub #2544, CLAUDE.md mandatory rules ignored — https://claudeissues.com/issue/2544-bug-claude-md-mandatory-rules-consistently-ignored-across-multiple-repositories (+ #17530 https://github.com/anthropics/claude-code/issues/17530)
- [S-GH11487] GitHub #11487, repeated file-read loop / premature compaction — https://claudeissues.com/issue/11487-bug-infinite-context-loop-repeated-file-reading-premature-compaction
- [S-ONBOARD] Anthropic, onboarding Claude Code like a new developer — https://www.claude.com/blog/onboarding-claude-code-like-a-new-developer-lessons-from-17-years-of-development
- [S-FOWLER] Martin Fowler, onboarding to a legacy codebase with AI — https://martinfowler.com/articles/exploring-gen-ai/09-ai-help-onboarding-codebase.html
- [S-JB-LEGACY] JetBrains TeamCity, teaching agents the bigger picture — https://blog.jetbrains.com/teamcity/2026/03/how-we-taught-ai-agents-to-see-the-bigger-picture/

## Ecosystem directories (LIKELY; third-party curation)
- [S-AWE] hesreallyhim/awesome-claude-code — https://github.com/hesreallyhim/awesome-claude-code
- [S-COMPO] ComposioHQ/awesome-claude-plugins + Composio top-plugins roundup — https://github.com/ComposioHQ/awesome-claude-plugins ; https://composio.dev/content/top-claude-code-plugins
