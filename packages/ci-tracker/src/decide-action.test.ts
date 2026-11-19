import { describe, expect, it } from 'vitest';
import { decideAction, decideMergeAction, REVIEW_REJECTION_THRESHOLD } from './decide-action';
import type { ReviewVerdict } from './decide-action';
import type { GitHubCheckState } from '@yaaabk/github';

interface Case {
  name: string;
  checks: GitHubCheckState;
  verdict: ReviewVerdict;
  rejections: number;
  attempts: number;
  budget: number;
  expected: 'wait' | 'spawn-review' | 'merge' | 'fix' | 'escalate';
}

const cases: Case[] = [
  // Pending checks always wait, whatever else is true.
  {
    name: 'waits while checks are pending, even with an approval',
    checks: 'pending',
    verdict: 'approve',
    rejections: 0,
    attempts: 0,
    budget: 3,
    expected: 'wait',
  },
  {
    name: 'waits while checks are pending, even with request-changes',
    checks: 'pending',
    verdict: 'request-changes',
    rejections: 1,
    attempts: 2,
    budget: 3,
    expected: 'wait',
  },

  // Failing checks spawn a fix until the attempt budget is spent.
  {
    name: 'fixes failing checks when attempts remain',
    checks: 'failure',
    verdict: 'none',
    rejections: 0,
    attempts: 0,
    budget: 3,
    expected: 'fix',
  },
  {
    name: 'fixes failing checks on the last remaining attempt',
    checks: 'failure',
    verdict: 'none',
    rejections: 0,
    attempts: 2,
    budget: 3,
    expected: 'fix',
  },
  {
    name: 'escalates failing checks once the attempt budget is spent',
    checks: 'failure',
    verdict: 'none',
    rejections: 0,
    attempts: 3,
    budget: 3,
    expected: 'escalate',
  },
  {
    name: 'ignores a review verdict while checks fail',
    checks: 'failure',
    verdict: 'approve',
    rejections: 0,
    attempts: 0,
    budget: 3,
    expected: 'fix',
  },

  // Green checks with no verdict ask for a review.
  {
    name: 'spawns a review when checks pass and no review exists',
    checks: 'success',
    verdict: 'none',
    rejections: 0,
    attempts: 0,
    budget: 3,
    expected: 'spawn-review',
  },
  {
    name: 'spawns a review again when checks pass after a new head commit',
    checks: 'success',
    verdict: 'none',
    rejections: 1,
    attempts: 1,
    budget: 3,
    expected: 'spawn-review',
  },

  // Green checks with an approval merge, whatever the history.
  {
    name: 'merges green checks with an approval',
    checks: 'success',
    verdict: 'approve',
    rejections: 0,
    attempts: 0,
    budget: 3,
    expected: 'merge',
  },
  {
    name: 'merges an approval even when the attempt budget is spent',
    checks: 'success',
    verdict: 'approve',
    rejections: 1,
    attempts: 3,
    budget: 3,
    expected: 'merge',
  },

  // Request-changes fixes while under both thresholds.
  {
    name: 'fixes request-changes below the rejection threshold and budget',
    checks: 'success',
    verdict: 'request-changes',
    rejections: 1,
    attempts: 0,
    budget: 3,
    expected: 'fix',
  },
  {
    name: 'fixes the last rejection below the threshold on the last attempt',
    checks: 'success',
    verdict: 'request-changes',
    rejections: 1,
    attempts: 2,
    budget: 3,
    expected: 'fix',
  },
  {
    name: 'escalates request-changes at the rejection threshold',
    checks: 'success',
    verdict: 'request-changes',
    rejections: REVIEW_REJECTION_THRESHOLD,
    attempts: 0,
    budget: 3,
    expected: 'escalate',
  },
  {
    name: 'escalates request-changes when the attempt budget is spent',
    checks: 'success',
    verdict: 'request-changes',
    rejections: 0,
    attempts: 3,
    budget: 3,
    expected: 'escalate',
  },
  {
    name: 'escalates request-changes past both thresholds',
    checks: 'success',
    verdict: 'request-changes',
    rejections: REVIEW_REJECTION_THRESHOLD,
    attempts: 3,
    budget: 3,
    expected: 'escalate',
  },
];

describe('decideAction', () => {
  it.each(cases)('$name', ({ checks, verdict, rejections, attempts, budget, expected }) => {
    expect(decideAction(checks, verdict, rejections, attempts, budget)).toBe(expected);
  });

  it('never merges a negative verdict, whatever the history', () => {
    for (const rejections of [0, 1, REVIEW_REJECTION_THRESHOLD]) {
      for (const attempts of [0, 2, 3]) {
        expect(decideAction('success', 'request-changes', rejections, attempts, 3)).not.toBe(
          'merge',
        );
      }
    }
  });
});

describe('decideMergeAction', () => {
  it('merges a mergeable pull request', () => {
    expect(decideMergeAction('mergeable', 0, 2)).toBe('merge');
  });

  it('waits while GitHub is still computing mergeability', () => {
    expect(decideMergeAction('unknown', 0, 2)).toBe('wait');
  });

  it('spawns a conflict resolution while the budget lasts', () => {
    expect(decideMergeAction('conflicting', 0, 2)).toBe('resolve-conflicts');
    expect(decideMergeAction('conflicting', 1, 2)).toBe('resolve-conflicts');
  });

  it('escalates once the conflict budget is spent', () => {
    expect(decideMergeAction('conflicting', 2, 2)).toBe('escalate');
    expect(decideMergeAction('conflicting', 0, 0)).toBe('escalate');
  });
});
