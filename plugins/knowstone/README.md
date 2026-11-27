# Knowstone

Local-first **verified memory** for Claude Code.

Knowstone remembers your project's important facts — bug root causes, architectural
decisions, conventions, structure, DB schema, routes — and binds each one to a hash of the
code it was derived from. The moment that code changes, Knowstone **withholds the fact and
asks for re-verification** instead of letting Claude act on something that may no longer be
true. Still-current findings are placed into context automatically at the start of a
session, so Claude has your verified knowledge without having to go looking for it.

It is deliberately:

- **local-first** — no external services, no embedding API, no source code leaves your
  machine;
- **lean** — skills plus small local scripts, no always-on MCP server;
- **safe** — never stores anything that looks like a secret; read-only against your code;
- **stack-agnostic** — understands PHP/Laravel, Node/TypeScript and generic structure, and
  degrades to "unknown, go and look" rather than guessing on anything it cannot parse.

## What it is, and what it is not

**It is** a trust layer over project knowledge: a recorded finding is served only while the
code it depends on is unchanged, and held for a human to re-confirm once that code moves.
That guarantee is the point of the tool, and it is tested (see
[`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md): **0 stale serves**).

**It is not** sold on a token-savings number. Any "saves X%" figure you have seen for tools
like this is a hypothesis, not a measurement; Knowstone makes no such claim. If a saving is
ever claimed here, it will trace to a run in `benchmarks/`.

## How it works

1. `knowstone:map` indexes the repo once (structure, routes, DB tables, scripts) into a
   small local cache. Read-only; it never writes to your project.
2. `knowstone:note` records a verified finding and binds it to the **dependency cone** of
   the files it came from (those files and what they import). The finding is hashed against
   that cone.
3. On each later session, the project card puts the **still-current** findings straight into
   context. `knowstone:recall` returns the full list on demand.
4. When any file in a finding's cone changes, its hash no longer matches, so the finding is
   **withheld** ("needs re-verify") rather than served. Re-check it and record a fresh note
   if it still holds; the old one stays in history.

## Commands (skills)

| Command            | What it does                                                                       |
| ------------------ | ---------------------------------------------------------------------------------- |
| `knowstone:map`    | Build or refresh the local index of structure, DB schema, routes and scripts       |
| `knowstone:note`   | Record a verified finding, bound to the code it depends on                         |
| `knowstone:recall` | Retrieve findings; stale ones are shown as "needs re-verify", never served as fact |

## Install

> Not published to a public marketplace yet. This is a release candidate.

Once published, on Claude Code 2.1.275 or later:

```
/plugin marketplace add usama-hafeez/knowstone
/plugin install knowstone@custom-claude-plugins
```

Requires Node.js 20 or later on your PATH (the skills and the session card run small Node
scripts). There are no other runtime dependencies and nothing is compiled on your machine —
the plugin ships its built output.

## Privacy

- Everything stays on your machine. Knowstone makes no network calls and sends nothing to
  any external service.
- It reads your code to hash it and extract structure; it never writes to your project.
- Before storing any finding it runs a secret scan (entropy plus known key patterns plus
  `.env`/key filenames) and refuses to store anything that looks like a credential.
- Stored data lives under your Claude config directory at `plugins/data/` (the value of
  `CLAUDE_PLUGIN_DATA`), keyed per project, and is git-ignored wherever a per-project cache
  is used.

## Uninstall and forget

```
/plugin uninstall knowstone@custom-claude-plugins
```

Uninstalling stops the plugin but leaves your recorded findings on disk. To **forget**
everything Knowstone has stored, also delete its data folder under your Claude config
directory's `plugins/data/` (the folder named `knowstone`). Findings are plain JSON, so you
can inspect them there first.

## Troubleshooting

- **The card says "no project map yet".** Run `knowstone:map` in the project once; the card
  and recall read the index it builds.
- **A finding shows "needs re-verify".** That is by design: the code it was bound to has
  changed. Re-check it against the current code; if it still holds, record a fresh note.
- **"plugin not built" from a skill.** You are running from source without a build. Run
  `npm run build` in `plugins/knowstone`. (A normal install ships the built `dist/`, so this
  only happens in a dev checkout.)
- **Nothing recalls in a fresh session.** Findings are per-project and per-machine. If you
  moved the repo or are on another machine, the store does not follow it.

## Development

```bash
cd plugins/knowstone
npm install
npm run build
npm run typecheck && npm run lint && npm run format:check && npm test
```

The compiled `dist/` is committed (Claude Code installs by copying the repo and does not run
a build), and CI fails if it drifts from `src/`. Rebuild and commit `dist/` with any source
change.

## Licence

MIT © usama-hafeez
