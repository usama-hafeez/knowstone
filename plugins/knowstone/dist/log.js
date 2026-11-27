/**
 * Knowstone — structured JSONL event log.
 *
 * A single append-only log under the plugin data dir records the decisions the
 * engine makes, one JSON object per line. Its primary job (PLAN.md M5) is an audit
 * trail of every freshness decision — so a "why was this withheld?" question has a
 * concrete answer — but it also records self-heal and cache-eviction events.
 *
 * Rules:
 *  - Best-effort: logging must never throw and never break the operation it is
 *    recording. Any failure is swallowed.
 *  - Privacy: we log the project KEY (a hash), never the absolute project path, and
 *    never a fact's statement text or any file contents — only ids, statuses, short
 *    reasons and counts. Nothing sensitive is written here.
 *  - Bounded: the log self-rotates at a size cap so it cannot grow without limit.
 */
import { existsSync, mkdirSync, renameSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
/** Size at which events.jsonl is rotated to events.jsonl.1 (one backup kept). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** The directory holding Knowstone's logs for a given data dir. */
export function logsDir(baseDir) {
    return join(baseDir, "logs");
}
/** The current event-log file path for a given data dir. */
export function logFilePath(baseDir) {
    return join(logsDir(baseDir), "events.jsonl");
}
/** Rotate the log when it has grown past the cap. Best-effort; keeps one backup. */
function rotateIfNeeded(filePath) {
    try {
        if (!existsSync(filePath))
            return;
        if (statSync(filePath).size < MAX_LOG_BYTES)
            return;
        renameSync(filePath, `${filePath}.1`); // overwrites any previous backup
    }
    catch {
        // If rotation fails we simply keep appending; a too-large log is not fatal.
    }
}
/**
 * Append one structured event to the log. `type` names the event kind
 * ("freshness", "store-quarantine", "cache-evict", "isolation-collision", ...),
 * `fields` carries the structured payload, and `at` is the epoch-ms timestamp
 * (defaults to now; injectable for deterministic tests). Never throws.
 */
export function logEvent(baseDir, type, fields = {}, at) {
    try {
        const dir = logsDir(baseDir);
        mkdirSync(dir, { recursive: true });
        const filePath = logFilePath(baseDir);
        rotateIfNeeded(filePath);
        const record = { at: at ?? Date.now(), type, ...fields };
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    }
    catch {
        // Logging is never allowed to break the operation it records.
    }
}
