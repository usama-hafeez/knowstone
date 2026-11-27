/**
 * Knowstone benchmark — blind, deterministic grading helpers.
 *
 * Correctness is graded by pure predicates over the answer TEXT only. The grader
 * never sees which arm produced the answer, so grading is blind by construction
 * and fully reproducible: anyone can re-run it over the stored transcripts and get
 * the same verdicts. The tasks are designed to have crisp, checkable answers (an
 * exact route path, a set of column names, the one value a mid-session edit
 * changed) so a keyword predicate is a fair judge.
 *
 * Limitation, stated plainly: a keyword grader can be fooled by an answer that
 * mentions the right token for the wrong reason. The adversarial tasks guard the
 * one case that matters most, by also checking that the STALE value is absent;
 * and every run's full transcript is kept so a human can re-grade if needed.
 */

/** Lower-case and collapse whitespace so matching is robust to formatting. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True iff every needle appears in the answer (case-insensitive). */
export function containsAll(answer: string, needles: string[]): boolean {
  const hay = normalise(answer);
  return needles.every((n) => hay.includes(normalise(n)));
}

/** True iff at least one needle appears in the answer (case-insensitive). */
export function containsAny(answer: string, needles: string[]): boolean {
  const hay = normalise(answer);
  return needles.some((n) => hay.includes(normalise(n)));
}

/** True iff the needle appears as a whole word (not as part of another token). */
export function containsWord(answer: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(answer);
}

/**
 * Decide the adversarial verdict from the two candidate values.
 *
 * Detection is by SUBSTRING (case-insensitive), not word boundary: a version like
 * "0.1.0" can appear as "v0.1.0", and missing a stale serve is the dangerous
 * direction, so we err towards catching it. The outcomes:
 *   - only the stale value present  -> STALE SERVE (correct: false). The plugin, or
 *     the model, answered with a value the mid-session edit had invalidated.
 *   - only the fresh value present  -> correct.
 *   - both present                  -> ambiguous: not scored as correct and not as a
 *     clean stale serve; flagged for transcript review. (The engine-level correctness
 *     harness is the rigorous stale proof; this A/B check is secondary.)
 *   - neither present               -> declined / re-verified; not correct, not stale.
 */
export function gradeAdversarial(
  answer: string,
  freshValue: string,
  staleValue: string,
): { correct: boolean; staleServed: boolean; note: string } {
  const hay = normalise(answer);
  const sawFresh = freshValue !== "" && hay.includes(normalise(freshValue));
  const sawStale = staleValue !== "" && hay.includes(normalise(staleValue));

  if (sawStale && !sawFresh) {
    return {
      correct: false,
      staleServed: true,
      note: `served stale value "${staleValue}" after the file changed`,
    };
  }
  if (sawFresh && !sawStale) {
    return { correct: true, staleServed: false, note: `used fresh value "${freshValue}"` };
  }
  if (sawFresh && sawStale) {
    return {
      correct: false,
      staleServed: false,
      note: `mentions both "${freshValue}" and "${staleValue}"; review transcript`,
    };
  }
  return {
    correct: false,
    staleServed: false,
    note: "answered with neither value (declined / explored to re-verify)",
  };
}
