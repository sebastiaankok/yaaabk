import type { AgentRun } from '@yaaabk/agents';
import type { Issue } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';
import type { Project } from '@yaaabk/projects';
import { describe, expect, it } from 'vitest';
import { composeProjectOverview } from './overview';

const PROJECT: Project = {
  id: 'project-1',
  name: 'todo-app',
  description: 'A todo list',
  skillLevel: 'expert',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
  lastModel: null,
  agentModel: null,
  deployedCommitSha: null,
  lastDeployStatus: null,
  lastDeployAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A complete {@link Plan}, overridable per test. */
function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    version: 2,
    contentMarkdown: '# Plan',
    summary: 'A plan',
    skillLevel: 'expert',
    source: 'grill-me',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
    acceptedAt: null,
    ...overrides,
  };
}

/** A complete {@link Issue}, overridable per test. */
function issue(overrides: Partial<Issue> & { title: string }): Issue {
  return {
    id: overrides.title.toLowerCase().replace(/\s+/g, '-'),
    projectId: 'project-1',
    planId: null,
    githubNumber: null,
    githubSyncedAt: null,
    body: '',
    summary: null,
    status: 'open',
    label: 'ready',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 50,
    openrouterKeyHash: null,
    agentModel: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete {@link AgentRun}, overridable per test. */
function run(overrides: Partial<AgentRun> & { id: string }): AgentRun {
  return {
    projectId: 'project-1',
    issueId: 'add-login',
    kind: 'implement-issue',
    attemptNumber: 1,
    pullNumber: null,
    commitSha: null,
    jobName: null,
    pvcName: null,
    openrouterSecretName: null,
    branch: null,
    reviewFeedback: null,
    status: 'success',
    model: null,
    prUrl: null,
    reviewVerdict: null,
    reviewBody: null,
    logs: null,
    costCents: 0,
    tokens: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('composeProjectOverview', () => {
  it('summarizes an unaccepted active plan', () => {
    const overview = composeProjectOverview(PROJECT, plan(), [], []);

    expect(overview.project).toBe(PROJECT);
    expect(overview.activePlan).toEqual({ id: 'plan-1', version: 2, acceptedAt: null });
  });

  it('has no active plan when the project has none', () => {
    const overview = composeProjectOverview(PROJECT, null, [], []);

    expect(overview.activePlan).toBeNull();
  });

  it('keeps the acceptance time of an accepted active plan', () => {
    const acceptedAt = '2026-01-02T00:00:00.000Z';

    const overview = composeProjectOverview(PROJECT, plan({ acceptedAt }), [], []);

    expect(overview.activePlan).toEqual({ id: 'plan-1', version: 2, acceptedAt });
  });

  it('lists only queued and running work, newest first, with its issue title', () => {
    const issues = [issue({ title: 'Add login' }), issue({ title: 'Schema' })];
    const runs = [
      run({
        id: 'run-1',
        issueId: 'add-login',
        attemptNumber: 2,
        status: 'running',
        createdAt: '2026-01-02T00:00:00.000Z',
        startedAt: '2026-01-02T00:01:00.000Z',
      }),
      run({
        id: 'run-2',
        issueId: 'schema',
        kind: 'review',
        status: 'queued',
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
      run({ id: 'run-3', issueId: 'add-login', status: 'success' }),
    ];

    const overview = composeProjectOverview(PROJECT, null, issues, runs);

    expect(overview.activeWork).toEqual([
      {
        id: 'run-2',
        issueId: 'schema',
        issueTitle: 'Schema',
        kind: 'review',
        attemptNumber: 1,
        status: 'queued',
        createdAt: '2026-01-03T00:00:00.000Z',
        startedAt: null,
      },
      {
        id: 'run-1',
        issueId: 'add-login',
        issueTitle: 'Add login',
        kind: 'implement-issue',
        attemptNumber: 2,
        status: 'running',
        createdAt: '2026-01-02T00:00:00.000Z',
        startedAt: '2026-01-02T00:01:00.000Z',
      },
    ]);
  });

  it('reports the last run time across every run', () => {
    const runs = [
      run({ id: 'run-1', status: 'running', createdAt: '2026-01-02T00:00:00.000Z' }),
      run({ id: 'run-2', status: 'failed', createdAt: '2026-01-04T00:00:00.000Z' }),
      run({ id: 'run-3', status: 'success', createdAt: '2026-01-03T00:00:00.000Z' }),
    ];

    const overview = composeProjectOverview(PROJECT, null, [], runs);

    expect(overview.lastRunAt).toBe('2026-01-04T00:00:00.000Z');
  });

  it('reports no last run time for a project with no runs', () => {
    const overview = composeProjectOverview(PROJECT, null, [], []);

    expect(overview.lastRunAt).toBeNull();
  });

  it('counts the issues by status', () => {
    const issues = [
      issue({ title: 'Open' }),
      issue({ title: 'Active', status: 'in_progress' }),
      issue({ title: 'Done', status: 'closed' }),
      issue({ title: 'Broke', status: 'failed' }),
    ];

    const overview = composeProjectOverview(PROJECT, null, issues, []);

    expect(overview.issues).toMatchObject({
      total: 4,
      open: 1,
      inProgress: 1,
      closed: 1,
      failed: 1,
    });
  });
});
