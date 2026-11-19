import type { GitHubCheckState } from '@yaaabk/github';

/** The verdict the tracker reads from a pull request's latest review. */
export type ReviewVerdict = 'none' | 'approve' | 'request-changes';

/** What the loop should do for a pull request's current head commit. */
export type DecideAction = 'wait' | 'spawn-review' | 'merge' | 'fix' | 'escalate';

/**
 * How many request-changes verdicts a pull request may collect before the
 * tracker escalates to a human instead of spawning another fix attempt.
 */
export const REVIEW_REJECTION_THRESHOLD = 2;

/**
 * Decides what the CI loop should do, from the facts it has gathered.
 *
 * Pure and dependency-free: no cluster, GitHub or clock. The policy is:
 *
 * - Pending checks always wait.
 * - Failing checks spawn a fix attempt while the Issue's attempt budget lasts,
 *   then escalate. A review verdict is irrelevant while checks are red.
 * - Green checks with no verdict spawn a review.
 * - Green checks with an approval merge.
 * - Green checks with request-changes spawn a fix attempt until either the
 *   rejection count reaches {@link REVIEW_REJECTION_THRESHOLD} or the attempt
 *   budget is spent, then escalate.
 *
 * `rejections` is the number of request-changes verdicts counted so far,
 * including the one being decided on.
 */
export function decideAction(
  checks: GitHubCheckState,
  verdict: ReviewVerdict,
  rejections: number,
  attempts: number,
  budget: number,
): DecideAction {
  if (checks === 'pending') return 'wait';
  if (checks === 'failure') return attempts >= budget ? 'escalate' : 'fix';

  switch (verdict) {
    case 'none':
      return 'spawn-review';
    case 'approve':
      return 'merge';
    case 'request-changes':
      if (attempts >= budget || rejections >= REVIEW_REJECTION_THRESHOLD) return 'escalate';
      return 'fix';
  }
}

/** Whether GitHub can merge a reviewed pull request. */
export type MergeReadiness = 'mergeable' | 'conflicting' | 'unknown';

/** What the tracker should do once checks and review both allow a merge. */
export type MergeDecision = 'merge' | 'resolve-conflicts' | 'wait' | 'escalate';

/**
 * Decides how to get an approved, green pull request merged.
 *
 * A conflicting branch needs an Agent to merge the base branch and resolve the
 * markers; a bounded number of those attempts is allowed before escalating.
 * `unknown` means GitHub has not finished computing mergeability, so waiting a
 * poll is cheaper than spawning against a stale answer.
 */
export function decideMergeAction(
  readiness: MergeReadiness,
  conflictAttempts: number,
  maxConflictAttempts: number,
): MergeDecision {
  switch (readiness) {
    case 'unknown':
      return 'wait';
    case 'conflicting':
      return conflictAttempts >= maxConflictAttempts ? 'escalate' : 'resolve-conflicts';
    case 'mergeable':
      return 'merge';
  }
}
