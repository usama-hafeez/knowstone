# Contributing

Thanks for your interest in Knowstone.

## Ground rules

- **Correctness over cleverness.** Knowstone's whole point is never serving a stale or
  unverified fact. A change that trades correctness for speed or token savings will not be
  merged. Freshness and stale-detection tests must stay green.
- **No unmeasured claims.** Any statement about token or time savings must trace to the
  benchmark harness in `plugins/knowstone` (see `PLAN.md` milestone M6), not to a blog
  figure.
- **Local-first and private.** Do not add network calls, telemetry, or anything that sends
  source code off the machine to the core path. Optional, opt-in, clearly-labelled sync is
  a separate V2 discussion.
- **Never cache secrets.** Changes must keep the secret-scan guard in the write path.

## Development

```bash
cd plugins/knowstone
npm install
npm run typecheck
npm run lint
npm test
```

Before opening a PR: `npm run typecheck && npm run lint && npm run format:check && npm test`
must pass, and `claude plugin validate ./plugins/knowstone` should pass (an icon warning is
fine until release).

## Commits & PRs

- Small, focused changes that match the existing style.
- Describe the problem the change solves and how you verified it.
- New behaviour needs a test. Changes to freshness/invalidation need a test that proves a
  stale fact is withheld.
