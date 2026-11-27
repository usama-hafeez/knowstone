/**
 * Content hashing and a deterministic Merkle-style root for the freshness engine.
 *
 * We use SHA-256 from node:crypto (not xxhash) on purpose, to avoid native build
 * issues. Hashes are returned as lowercase hex. Repo-relative paths are always
 * stored and compared with forward slashes, since this repo also runs on Windows.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
/** Hash raw bytes or a string. Returns lowercase hex sha256. */
export function hashContent(data) {
    return createHash("sha256").update(data).digest("hex");
}
/** Convert any slash style to forward slashes for a stable repo-relative path. */
function toForwardSlashes(relPath) {
    return relPath.replace(/\\/g, "/");
}
/**
 * Hash one file on disk. root is the repo root (absolute); relPath is
 * repo-relative (any slash style accepted, stored as forward slashes). Throws a
 * clear Error if the file does not exist.
 */
export function hashFile(root, relPath) {
    const normalised = toForwardSlashes(relPath);
    const absolute = join(root, normalised);
    let bytes;
    let size;
    try {
        bytes = readFileSync(absolute);
        size = statSync(absolute).size;
    }
    catch (cause) {
        throw new Error(`hashFile: cannot read file "${normalised}" (resolved to "${absolute}")`, {
            cause,
        });
    }
    return {
        path: normalised,
        hash: hashContent(bytes),
        size,
    };
}
/**
 * Hash many files. Returns a Map keyed by the normalised forward-slash
 * repo-relative path. Missing files throw with a message naming the path.
 */
export function hashFiles(root, relPaths) {
    const result = new Map();
    for (const relPath of relPaths) {
        const fileHash = hashFile(root, relPath);
        result.set(fileHash.path, fileHash);
    }
    return result;
}
/**
 * Deterministic Merkle-style root over a set of file hashes. The result is
 * independent of the input array order (we sort internally by path), so the same
 * set always yields the same root. Empty input returns the sha256 of the empty
 * string. We combine by hashing the concatenation of "path\u0000hash\n" lines in
 * sorted path order. Returns lowercase hex.
 */
export function merkleRoot(hashes) {
    const sorted = [...hashes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const combined = createHash("sha256");
    for (const file of sorted) {
        combined.update(`${file.path}\u0000${file.hash}\n`);
    }
    return combined.digest("hex");
}
