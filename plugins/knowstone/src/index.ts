/**
 * Knowstone — local-first verified memory for Claude Code.
 *
 * This is the package entry point. The real engine (hashing, dependency cones,
 * freshness checks, storage) lands in milestone M1 onward; see ../../../PLAN.md.
 */

export const KNOWSTONE_VERSION = "0.1.0";

/** Trivial smoke helper so the M0 skeleton has something to build and test. */
export function banner(): string {
  return `knowstone ${KNOWSTONE_VERSION}`;
}
