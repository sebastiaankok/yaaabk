import type { ActiveWork, ProjectOverview } from '@yaaabk/stats';
import { describe, expect, it } from 'vitest';
import { projectTabIndicators } from './project-tab-indicators';

/** An overview around the fixture Project, with no Plan and no work in flight. */
function overview(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    project: {
      id: 'p1',
      name: 'todo-app',
      description: 'A todo list',
      mode: 'guided',
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
    },
    activePlan: null,
    activeWork: [],
    issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
    lastRunAt: null,
    ...overrides,
  };
}

/** One queued or running Agent run for the Issues badge. */
function activeRun(id: string): ActiveWork {
  return {
    id,
    issueId: `issue-${id}`,
    issueTitle: `Issue ${id}`,
    kind: 'implement-issue',
    attemptNumber: 1,
    status: 'running',
    createdAt: '2026-02-03T01:00:00.000Z',
    startedAt: '2026-02-03T01:01:00.000Z',
  };
}

describe('projectTabIndicators', () => {
  it('shows no indicators before an overview is available', () => {
    expect(projectTabIndicators(null)).toEqual({ review: null, issues: null });
  });

  it('shows no indicators when the Project has no Plan and no active runs', () => {
    expect(projectTabIndicators(overview())).toEqual({ review: null, issues: null });
  });

  it('marks Review while the active Plan waits for acceptance', () => {
    expect(
      projectTabIndicators(
        overview({ activePlan: { id: 'plan-1', version: 3, acceptedAt: null } }),
      ),
    ).toEqual({
      review: { label: 'Plan v3 not accepted' },
      issues: null,
    });
  });

  it('hides the Review indicator once the Developer accepted the Plan', () => {
    expect(
      projectTabIndicators(
        overview({
          activePlan: {
            id: 'plan-1',
            version: 3,
            acceptedAt: '2026-02-02T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual({ review: null, issues: null });
  });

  it('hides the Issues badge when no agent runs are in flight', () => {
    expect(projectTabIndicators(overview({ activeWork: [] }))).toEqual({
      review: null,
      issues: null,
    });
  });

  it('counts every queued and running agent on the Issues tab', () => {
    expect(
      projectTabIndicators(
        overview({ activeWork: [activeRun('r1'), activeRun('r2'), activeRun('r3')] }),
      ),
    ).toEqual({
      review: null,
      issues: { count: 3, label: '3 active agent runs' },
    });
  });

  it('uses the singular for a single active agent run', () => {
    expect(projectTabIndicators(overview({ activeWork: [activeRun('r1')] }))).toEqual({
      review: null,
      issues: { count: 1, label: '1 active agent run' },
    });
  });

  it('reports a pending review beside the active runs', () => {
    expect(
      projectTabIndicators(
        overview({
          activePlan: { id: 'plan-1', version: 2, acceptedAt: null },
          activeWork: [activeRun('r1'), activeRun('r2')],
        }),
      ),
    ).toEqual({
      review: { label: 'Plan v2 not accepted' },
      issues: { count: 2, label: '2 active agent runs' },
    });
  });
});
