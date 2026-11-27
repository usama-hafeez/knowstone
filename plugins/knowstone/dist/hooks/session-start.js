/**
 * Knowstone — SessionStart hook entry.
 *
 * Emits the tiny, static project card as SessionStart additionalContext. It reads
 * only the stored index cache (never scans the repo), so it is fast and
 * cache-friendly. The plugin exports CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR to
 * the hook process; this reads them to locate the per-project store. If anything
 * is missing it stays silent (empty context) rather than failing the session.
 *
 * Wired from hooks/hooks.json as an exec-form command:
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-start.js
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { renderCard } from "../card.js";
import { canonicalProjectRoot } from "../store.js";
function main() {
    const baseDir = process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), ".claude", "plugins", "data", "knowstone");
    const projectRoot = canonicalProjectRoot(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    let additionalContext = "";
    try {
        additionalContext = renderCard({ baseDir, projectRoot });
    }
    catch {
        // Never let the card break session start: emit no context on any failure.
        additionalContext = "";
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext,
        },
    }));
}
main();
