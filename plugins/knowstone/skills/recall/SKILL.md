---
description: Retrieve Knowstone's verified findings for this project, each freshness-checked against the current code. Findings whose code changed are shown as "needs re-verify" and must not be trusted as current. Use when returning to a project, investigating a recurring issue, or before acting on a past conclusion.
allowed-tools: Bash(node:*)
---

# Recall verified findings

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" recall --data "${CLAUDE_PLUGIN_DATA}"
```

Add `--query "<words>"` to filter by statement text.

How to use the output:

- **FRESH — safe to use**: the code these findings depend on is unchanged, so you may rely on them as current.
- **NEEDS RE-VERIFY**: the underlying code has changed since the finding was recorded. Do **not** treat these as current facts. Re-check each against the code now; if it still holds, record a fresh finding with `knowstone:note` (the old one stays in history). This withholding is the whole point of Knowstone: a finding is never served once its code moved out from under it.
