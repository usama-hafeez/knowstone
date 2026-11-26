# Knowstone

Local-first **verified memory** for Claude Code.

Knowstone remembers your project's important facts — bug root causes, architectural
decisions, conventions, structure, DB schema, routes — and stamps each one with a hash of
the code it was derived from. The moment that code changes, Knowstone **withholds the fact
and asks for re-verification** instead of letting Claude act on something that is no longer
true.

It is deliberately:

- **local-first** — no external services, no embedding API, no source code leaves your
  machine;
- **lean** — skills plus small local scripts, no always-on MCP server;
- **safe** — never caches anything that looks like a secret; read-only by default;
- **stack-agnostic** — works across PHP/Laravel, Node/TypeScript, Python, Go and more.

## Status

Pre-release, under active development. Milestone M0 (project skeleton) is in place; the
freshness engine and skills follow. See [`../../PLAN.md`](../../PLAN.md) and
[`../../research/`](../../research/).

## Planned commands (skills)

| Command            | What it does                                                                       |
| ------------------ | ---------------------------------------------------------------------------------- |
| `knowstone:map`    | Build/refresh a local index of structure, DB schema and routes                     |
| `knowstone:note`   | Record a verified finding, bound to the code it depends on                         |
| `knowstone:recall` | Retrieve findings; stale ones are shown as "needs re-verify", never served as fact |

## Install

Not published yet. Once released:

```
/plugin install knowstone --marketplace usama-hafeez/knowstone
```

(Works in one step on Claude Code 2.1.275 or later.)

## Development

```bash
cd plugins/knowstone
npm install
npm run typecheck && npm run lint && npm test
```

## Licence

MIT © usama-hafeez
