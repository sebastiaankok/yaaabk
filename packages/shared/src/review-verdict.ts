/**
 * How a YAAABK review carries its verdict to the CI tracker.
 *
 * GitHub refuses an APPROVE or REQUEST_CHANGES review on a pull request its
 * author created: the Agent's installation token opens the pull request and
 * then reviews it, so the API answers 422 ("Can not approve your own pull
 * request"). A COMMENT review is allowed on one's own pull request, so the
 * verdict travels as a hidden marker in the body instead, and the tracker reads
 * it from there.
 */

/** The verdict a review reaches. */
export type ReviewVerdict = 'approve' | 'request-changes';

/** Marks a review body as carrying a YAAABK verdict. */
const VERDICT_MARKER = 'yaaabk-verdict';

/** The hidden marker line that encodes `verdict`. */
export function reviewVerdictMarker(verdict: ReviewVerdict): string {
  return `<!-- ${VERDICT_MARKER}: ${verdict} -->`;
}

/** `body` prefixed with the marker for `verdict`, for a COMMENT review. */
export function withReviewVerdict(verdict: ReviewVerdict, body: string): string {
  return `${reviewVerdictMarker(verdict)}\n\n${body}`;
}

/**
 * The verdict encoded in a review body, or undefined for an ordinary comment.
 *
 * Only the marker is read, so the human-readable body stays free-form.
 */
export function reviewVerdictFromBody(body: string): ReviewVerdict | undefined {
  const match = new RegExp(
    `<!--\\s*${VERDICT_MARKER}\\s*:\\s*(approve|request-changes)\\s*-->`,
  ).exec(body);
  return match?.[1] as ReviewVerdict | undefined;
}
