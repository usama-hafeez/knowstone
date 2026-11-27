# Changelog

All notable changes to Knowstone are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Release candidate for 0.1.0. Not yet published to a public marketplace.

### Added

- **Freshness engine** — file hashing, a Merkle tree over the repo, import-graph extraction
  and cone hashing, with a fixed check order that withholds a fact once its code changes.
  Works on git and no-git repositories.
- **Storage + secret guard** — a versioned, file-based local store with corruption recovery,
  per-project isolation, and a secret scan that refuses to store anything resembling a
  credential.
- **Indexer + extractors** — structure, routes (PHP/Laravel, Express, NestJS), DB tables
  (SQL and Laravel migrations) and npm scripts; incremental re-extraction via the Merkle
  diff.
- **Skills** — `knowstone:map`, `knowstone:note`, `knowstone:recall`.
- **Session card** — a SessionStart hook that places the still-current findings into context
  and withholds (only counts) any whose code has changed. Static and prompt-cache-safe.
- **Hardening** — degradation paths, size caps, structured JSONL logging of every freshness
  decision, and cross-OS path handling.
- **Benchmark** — a free adversarial correctness harness (CI-gated) and an A/B harness over
  the real Claude Code CLI. Result: **0 stale serves**; see `benchmarks/RESULTS.md`.
- **Packaging** — the compiled `dist/` is shipped so a fresh install needs no build step; CI
  verifies it stays in sync with `src/`.

### Claims

- **Proven:** the trust guarantee — Knowstone does not serve a finding once its code has
  changed.
- **Not claimed:** any token or cost saving. That remains unmeasured and no such figure is
  stated anywhere in this project.
