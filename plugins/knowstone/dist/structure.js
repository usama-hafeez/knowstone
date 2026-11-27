/**
 * Knowstone — structure extractor.
 *
 * Projects a project Index into a compact, deterministic summary of its shape:
 * how many files, the language breakdown, the top-level directories by size, and
 * the entry points (files nothing else imports). This is a Tier A derived view,
 * cheap to recompute, used by the session card.
 */
import { detectLanguage } from "./imports.js";
export function extractStructure(index) {
    const byLanguage = {};
    const dirCounts = new Map();
    for (const file of index.files) {
        const language = detectLanguage(file);
        if (language !== null)
            byLanguage[language] = (byLanguage[language] ?? 0) + 1;
        const slash = file.indexOf("/");
        const top = slash === -1 ? "." : file.slice(0, slash);
        dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
    }
    const topLevelDirs = [...dirCounts.entries()]
        .map(([name, fileCount]) => ({ name, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Entry points: files with no incoming import edge.
    const imported = new Set();
    for (const targets of index.graph.edges.values()) {
        for (const target of targets)
            imported.add(target);
    }
    const entryPoints = index.files.filter((file) => !imported.has(file)).sort();
    return {
        fileCount: index.files.length,
        byLanguage,
        topLevelDirs,
        entryPoints,
    };
}
