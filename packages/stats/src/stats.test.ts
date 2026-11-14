import type { AgentRun } from '@yaaabk/agents';
import type { Issue } from '@yaaabk/issues';
import { describe, expect, it } from 'vitest';
import { computeProjectStats } from './stats';

/** A complete {@link Issue}, overridable per test. */
function issue(overrides: Partial<Issue> & { title: string }): Issue {
  return {
    id: overrides.title.toLowerCase().replace(/\s+/g, '-'),
    projectId: 'project-1',
    planId: null,
    githubNumber: null,
    githubSyncedAt: null,
    body: '',
    status: 'open',
    label: 'ready',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 50,
    openrouterKeyHash: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete {@link AgentRun}, overridable per test. */
function run(overrides: Partial<AgentRun> & { id: string }): AgentRun {
  return {
    projectId: 'project-1',
    issueId: 'schema',
    attemptNumber: 1,
    jobName: null,
    pvcName: null,
    openrouterSecretName: null,
    branch: null,
    status: 'success',
    prUrl: null,
    logs: null,
    costCents: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-02-01T12:00:00.000Z');

describe('computeProjectStats', () => {
  it('counts issues by status', () => {
    const stats = computeProjectStats(
      [
        issue({ title: 'Open' }),
        issue({ title: 'Active', status: 'in_progress' }),
        issue({ title: 'Done', status: 'closed' }),
        issue({ title: 'Broke', status: 'failed' }),
      ],
      [],
      { now: NOW },
    );

    expect(stats.issues).toMatchObject({
      total: 4,
      open: 1,
      inProgress: 1,
      closed: 1,
      failed: 1,
    });
  });

  it('reports the Agent success rate over finished runs only', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' })],
      [
        run({ id: 'r1', status: 'success' }),
        run({ id: 'r2', status: 'success' }),
        run({ id: 'r3', status: 'failed' }),
        run({ id: 'r4', status: 'running' }),
      ],
      { now: NOW },
    );

    expect(stats.agents).toMatchObject({
      total: 4,
      succeeded: 2,
      failed: 1,
      active: 1,
      successRate: 2 / 3,
    });
  });

  it('reports no success rate when no run has finished', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' })],
      [run({ id: 'r1', status: 'queued' })],
      { now: NOW },
    );

    expect(stats.agents.successRate).toBeNull();
  });

  it('averages Agent attempts across every Issue', () => {
    const stats = computeProjectStats(
      [
        issue({ title: 'A', attemptCount: 0 }),
        issue({ title: 'B', attemptCount: 2 }),
        issue({ title: 'C', attemptCount: 4 }),
      ],
      [],
      { now: NOW },
    );

    expect(stats.issues.averageAttempts).toBe(2);
  });

  it('reports zero average attempts for a Project with no Issues', () => {
    const stats = computeProjectStats([], [], { now: NOW });

    expect(stats.issues.averageAttempts).toBe(0);
  });

  it('totals Agent spend and breaks it down by Issue', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' }), issue({ title: 'Api' }), issue({ title: 'Docs' })],
      [
        run({ id: 'r1', issueId: 'schema', costCents: 10 }),
        run({ id: 'r2', issueId: 'schema', costCents: 5 }),
        run({ id: 'r3', issueId: 'api', costCents: 20 }),
      ],
      { now: NOW },
    );

    expect(stats.agents.totalCostCents).toBe(35);
    expect(stats.costByIssue).toEqual([
      { issueId: 'api', title: 'Api', costCents: 20 },
      { issueId: 'schema', title: 'Schema', costCents: 15 },
    ]);
  });

  it('summarises the duration of completed runs in seconds', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' })],
      [
        run({
          id: 'r1',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:01:00.000Z',
        }),
        run({
          id: 'r2',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:05:00.000Z',
        }),
        run({
          id: 'r3',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:02:00.000Z',
        }),
        run({ id: 'r4', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null }),
      ],
      { now: NOW },
    );

    expect(stats.agents.duration).toEqual({
      averageSeconds: 160,
      minSeconds: 60,
      maxSeconds: 300,
    });
  });

  it('reports no duration before a run has finished', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' })],
      [run({ id: 'r1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null })],
      { now: NOW },
    );

    expect(stats.agents.duration).toEqual({
      averageSeconds: null,
      minSeconds: null,
      maxSeconds: null,
    });
  });

  it('computes Issue close velocity over the last 7, 14 and 30 days', () => {
    const closed = (title: string, closedAt: string) =>
      issue({ title, status: 'closed', closedAt });
    const stats = computeProjectStats(
      [
        closed('Today A', '2026-02-01T09:00:00.000Z'),
        closed('Today B', '2026-02-01T10:00:00.000Z'),
        closed('Four days ago', '2026-01-28T12:00:00.000Z'),
        closed('Twelve days ago', '2026-01-20T12:00:00.000Z'),
        closed('A month ago', '2026-01-01T12:00:00.000Z'),
      ],
      [],
      { now: NOW },
    );

    expect(stats.velocity.last7Days).toEqual({ closed: 3, perDay: 3 / 7 });
    expect(stats.velocity.last14Days).toEqual({ closed: 4, perDay: 4 / 14 });
    expect(stats.velocity.last30Days).toEqual({ closed: 4, perDay: 4 / 30 });
  });

  it('builds a daily timeline of Issues closed within the selected range', () => {
    const closed = (title: string, closedAt: string) =>
      issue({ title, status: 'closed', closedAt });
    const stats = computeProjectStats(
      [
        closed('Today A', '2026-02-01T09:00:00.000Z'),
        closed('Today B', '2026-02-01T10:00:00.000Z'),
        closed('Yesterday', '2026-01-31T12:00:00.000Z'),
        closed('Outside', '2026-01-01T12:00:00.000Z'),
      ],
      [],
      {
        now: NOW,
        from: new Date('2026-01-30T00:00:00.000Z'),
        to: new Date('2026-02-01T12:00:00.000Z'),
      },
    );

    expect(stats.closedPerDay).toEqual([
      { date: '2026-01-30', count: 0 },
      { date: '2026-01-31', count: 1 },
      { date: '2026-02-01', count: 2 },
    ]);
  });

  it('lists run history newest first with the Issue title and duration', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' })],
      [
        run({
          id: 'older',
          attemptNumber: 1,
          status: 'failed',
          costCents: 5,
          createdAt: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:02:00.000Z',
        }),
        run({
          id: 'newer',
          attemptNumber: 2,
          status: 'success',
          costCents: 9,
          prUrl: 'https://github.com/acme/todo-app/pull/7',
          createdAt: '2026-01-02T00:00:00.000Z',
          startedAt: '2026-01-02T00:00:00.000Z',
          finishedAt: '2026-01-02T00:01:30.000Z',
        }),
      ],
      { now: NOW },
    );

    expect(stats.runs).toEqual([
      {
        id: 'newer',
        issueId: 'schema',
        issueTitle: 'Schema',
        attemptNumber: 2,
        status: 'success',
        durationSeconds: 90,
        costCents: 9,
        prUrl: 'https://github.com/acme/todo-app/pull/7',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'older',
        issueId: 'schema',
        issueTitle: 'Schema',
        attemptNumber: 1,
        status: 'failed',
        durationSeconds: 120,
        costCents: 5,
        prUrl: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('filters Agent runs by the selected range', () => {
    const stats = computeProjectStats(
      [issue({ title: 'Schema' })],
      [
        run({ id: 'before', costCents: 1, createdAt: '2026-01-01T12:00:00.000Z' }),
        run({ id: 'inside', costCents: 2, createdAt: '2026-01-15T12:00:00.000Z' }),
        run({ id: 'after', costCents: 4, createdAt: '2026-02-01T12:00:01.000Z' }),
      ],
      {
        now: NOW,
        from: new Date('2026-01-10T00:00:00.000Z'),
        to: new Date('2026-02-01T12:00:00.000Z'),
      },
    );

    expect(stats.agents).toMatchObject({ total: 1, totalCostCents: 2 });
    expect(stats.costByIssue).toEqual([{ issueId: 'schema', title: 'Schema', costCents: 2 }]);
    expect(stats.runs.map((entry) => entry.id)).toEqual(['inside']);
  });

  it('rejects a range that ends before it starts', () => {
    expect(() =>
      computeProjectStats([], [], {
        now: NOW,
        from: new Date('2026-02-02T00:00:00.000Z'),
        to: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).toThrow(RangeError);
  });
});
