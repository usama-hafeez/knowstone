# custom-claude-plugins

A small marketplace of Claude Code plugins. First and current plugin: **Knowstone**.

> Note: the research in `research/` was written under the earlier working name
> "Keystone". The plugin ships as **Knowstone** (the ecosystem name "keystone" is already
> taken by KeystoneJS). Same product, final name.

## Knowstone

A local-first "verified memory" for Claude Code. It remembers your project's important
facts (bug root causes, architectural decisions, conventions, structure, DB schema) and
stamps each one with a hash of the code it came from. The moment that code changes,
Knowstone holds the fact for **re-verification** instead of letting Claude act on something
that is no longer true.

- Local-first. No external services, no embedding API, no source code leaves your machine.
- Never caches anything that looks like a secret.
- Built to work across languages and frameworks (PHP/Laravel, Node/TypeScript, Python,
  Go, and more), not tied to one stack.

**Status: release candidate (not yet published publicly).** The freshness engine, storage,
indexer, skills, session card, hardening and benchmark are all built and tested across Linux,
macOS and Windows on Node 20 and 22. The trust guarantee is proven (0 stale serves; see
[`plugins/knowstone/benchmarks/RESULTS.md`](./plugins/knowstone/benchmarks/RESULTS.md)). The
build plan is in [`PLAN.md`](./PLAN.md); the research that led here is in
[`research/`](./research/).

## Repository layout

```
custom-claude-plugins/
├── .claude-plugin/marketplace.json   # marketplace listing
├── plugins/
│   └── knowstone/                     # the Knowstone plugin (ships its built dist/)
├── research/                         # market/competitor/caching research
├── PLAN.md                           # phased development plan
└── README.md
```

## Install

Not published yet. Once released, on Claude Code 2.1.275 or later:

```
/plugin install knowstone --marketplace usama-hafeez/knowstone
```

(That GitHub repository is the marketplace you install from.)

## Licence

MIT © usama-hafeez. See [`LICENSE`](./LICENSE).

