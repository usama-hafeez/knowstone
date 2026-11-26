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

**Status: pre-development.** The research that led here is in [`research/`](./research/).
The build plan is in [`PLAN.md`](./PLAN.md). No plugin code is written yet.

## Repository layout (planned)

```
custom-claude-plugins/
├── .claude-plugin/marketplace.json   # marketplace listing (added in M0)
├── plugins/
│   └── knowstone/                     # the Knowstone plugin (added from M0)
├── research/                         # market/competitor/caching research (done)
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

