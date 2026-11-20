import { describe, expect, it } from 'vitest';
import type { Issue } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';
import { pendingGithubSync, planProgress, planStatusLabel } from './plan-lifecycle';

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    contentMarkdown: '# Plan',
    summary: null,
    mode: 'guided',
    source: 'grill-me',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
    acceptedAt: null,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    projectId: 'project-1',
    planId: 'plan-1',
    githubNumber: null,
    githubSyncedAt: null,
    title: overrides.id,
    body: '',
    summary: null,
    status: 'open',
    label: 'ready',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 100,
    openrouterKeyHash: null,
    agentModel: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('planProgress', () => {
  it('is not accepted until the plan has an acceptance date', () => {
    const progress = planProgress(plan(), [
      issue({ id: 'a', status: 'closed' }),
      issue({ id: 'b', status: 'closed' }),
    ]);

    expect(progress.status).toBe('not-accepted');
  });

  it('is in progress once accepted while any issue is still open', () => {
    const progress = planProgress(plan({ acceptedAt: '2026-02-01T00:00:00.000Z' }), [
      issue({ id: 'a', status: 'closed' }),
      issue({ id: 'b', status: 'open' }),
      issue({ id: 'c', status: 'failed' }),
    ]);

    expect(progress).toEqual({ status: 'in-progress', total: 3, closed: 1, failed: 1 });
  });

  it('is completed only when an accepted plan has issues and all are closed', () => {
    const accepted = plan({ acceptedAt: '2026-02-01T00:00:00.000Z' });

    expect(
      planProgress(accepted, [
        issue({ id: 'a', status: 'closed' }),
        issue({ id: 'b', status: 'closed' }),
      ]).status,
    ).toBe('completed');
    expect(planProgress(accepted, []).status).toBe('in-progress');
  });

  it('counts only the selected plan\u2019s issues', () => {
    const progress = planProgress(plan({ acceptedAt: '2026-02-01T00:00:00.000Z' }), [
      issue({ id: 'a', status: 'closed' }),
      issue({ id: 'other', planId: 'plan-2', status: 'open' }),
    ]);

    expect(progress).toMatchObject({ status: 'completed', total: 1, closed: 1 });
  });
});

describe('planStatusLabel', () => {
  it.each([
    ['not-accepted', 'Not accepted'],
    ['in-progress', 'In progress'],
    ['completed', 'Completed'],
  ] as const)('labels %s as %s', (status, label) => {
    expect(planStatusLabel(status)).toBe(label);
  });
});

describe('pendingGithubSync', () => {
  it('is true only for an accepted plan with issues that have no GitHub number', () => {
    const accepted = plan({ acceptedAt: '2026-02-01T00:00:00.000Z' });

    expect(pendingGithubSync(accepted, [issue({ id: 'a' })])).toBe(true);
    expect(pendingGithubSync(accepted, [issue({ id: 'a', githubNumber: 4 })])).toBe(false);
    expect(pendingGithubSync(plan(), [issue({ id: 'a' })])).toBe(false);
  });
});
