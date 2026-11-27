---
description: Record a verified finding (a bug root cause, an architectural decision, a project convention, or a "looks wrong but is intentional" note) bound to the code it came from, so it survives sessions but is withheld once that code changes. Use after verifying something worth remembering about this project.
allowed-tools: Bash(node:*)
---

# Record a verified finding

Record the finding, binding it to the files it was derived from (its evidence). Knowstone hashes the dependency cone of those files, so the finding is automatically held for re-verification if any of that code later changes.

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" note --data "${CLAUDE_PLUGIN_DATA}" --statement "<the finding, in one or two sentences>" --evidence "<repo-relative file[,file...] it was derived from>"
```

Guidance:

- Make the statement **specific and self-contained** — it will be read back cold in a future session with no other context.
- List every file the finding actually depends on as `--evidence` (comma-separated, repo-relative). Knowstone follows their imports automatically, so you only need the files you actually reasoned about, not their dependencies.
- Record a finding only once you have actually verified it, not a guess.
- Do **not** put secrets, tokens, or credentials in the statement. Knowstone refuses to store anything that looks like one.

Report the finding id and status the command prints.
