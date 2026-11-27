---
description: Build or refresh Knowstone's map of this project (structure, routes, DB tables, npm scripts) and save it. Use when asked to map, index, or outline the codebase, or to refresh the project map before recalling findings.
allowed-tools: Bash(node:*)
---

# Map the project

Run this from the project root and show the user the summary it prints:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" map --data "${CLAUDE_PLUGIN_DATA}"
```

This indexes the repository (read-only) and saves a small cache that Knowstone uses for the session card and for freshness checks. It writes only to Knowstone's own data directory, never to project files.

Report the counts it prints: source files and languages, routes, DB tables, npm scripts, and entry points. If the command fails because the plugin is not built, tell the user to run `npm run build` in the plugin directory.
