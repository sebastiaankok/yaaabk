import { describe, expect, it } from 'vitest';
import type { Issue, IssueGraph } from '@yaaabk/issues';
import {
  boardColumn,
  boardItems,
  budgetRemaining,
  dependencyEdges,
  pullRequestNumber,
  spendByIssue,
} from './issue-board';

function issue(overrides: Partial<Issue> & { title: string }): Issue {
  return {
    id: overrides.title.toLowerCase().replace(/\s+/g, '-'),
    projectId: 'project-1',
    planId: 'plan-1',
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

describe('boardColumn', () => {
  it('puts a closed issue in the closed lane', () => {
    const closed = issue({ title: 'Done', status: 'closed' });
    expect(boardColumn(closed)).toBe('closed');
  });

  it('puts a failed issue in the failed lane', () => {
    const failed = issue({ title: 'Broke', status: 'failed' });
    expect(boardColumn(failed)).toBe('failed');
  });

  it('puts an in-progress issue in the in-progress lane', () => {
    const active = issue({ title: 'Active', status: 'in_progress' });
    expect(boardColumn(active)).toBe('in_progress');
  });

  it('lifts an open issue labelled blocked into the blocked lane', () => {
    const stuck = issue({ title: 'Stuck', label: 'blocked' });
    expect(boardColumn(stuck)).toBe('blocked');
  });

  it('keeps other open issues in the ready lane', () => {
    for (const label of ['ready', 'refinement-needed', 'needs-human'] as const) {
      expect(boardColumn(issue({ title: label, label }))).toBe('ready');
    }
  });
});

describe('dependencyEdges', () => {
  it('draws an edge from each dependency to the issue that depends on it', () => {
    const graph: IssueGraph = {
      nodes: [
        { id: 'schema', title: 'Schema', dependsOn: [], missing: [], wave: 0 },
        { id: 'api', title: 'Api', dependsOn: ['schema'], missing: [], wave: 1 },
        { id: 'ui', title: 'Ui', dependsOn: ['schema', 'api'], missing: [], wave: 2 },
      ],
      cycles: [],
    };

    expect(dependencyEdges(graph)).toEqual([
      { from: 'schema', to: 'api' },
      { from: 'schema', to: 'ui' },
      { from: 'api', to: 'ui' },
    ]);
  });
});

function graph(
  nodes: Array<{ id: string; wave: number | null; dependsOn?: string[]; missing?: string[] }>,
): IssueGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.id,
      dependsOn: node.dependsOn ?? [],
      missing: node.missing ?? [],
      wave: node.wave,
    })),
    cycles: [],
  };
}

describe('boardItems', () => {
  it('enriches each issue with its lane and wave, ordered by wave with cycles last', () => {
    const schema = issue({ title: 'Schema' });
    const done = issue({ title: 'Done', status: 'closed', createdAt: '2026-01-02T00:00:00.000Z' });
    const api = issue({ title: 'Api', createdAt: '2026-01-03T00:00:00.000Z' });
    const loop = issue({ title: 'Loop', createdAt: '2026-01-04T00:00:00.000Z' });

    const items = boardItems(
      [api, loop, done, schema],
      graph([
        { id: 'schema', wave: 0 },
        { id: 'api', wave: 1 },
        { id: 'done', wave: 0 },
        { id: 'loop', wave: null },
      ]),
    );

    expect(items.map((item) => [item.issue.title, item.column, item.wave])).toEqual([
      ['Schema', 'ready', 0],
      ['Done', 'closed', 0],
      ['Api', 'ready', 1],
      ['Loop', 'ready', null],
    ]);
  });
});

describe('boardItems filtering', () => {
  const issues = [
    issue({ title: 'Schema', label: 'ready' }),
    issue({ title: 'Api', label: 'blocked', body: 'Build the endpoints' }),
    issue({ title: 'Done', status: 'closed', createdAt: '2026-01-02T00:00:00.000Z' }),
    issue({ title: 'Loop', createdAt: '2026-01-03T00:00:00.000Z' }),
  ];
  const g = graph([
    { id: 'schema', wave: 0 },
    { id: 'api', wave: 1 },
    { id: 'done', wave: 0 },
    { id: 'loop', wave: null },
  ]);

  it('filters by lane', () => {
    const ready = boardItems(issues, g, { filters: { column: 'ready' } });
    expect(ready.map((item) => item.issue.title)).toEqual(['Schema', 'Loop']);
  });

  it('filters by label', () => {
    const blocked = boardItems(issues, g, { filters: { label: 'blocked' } });
    expect(blocked.map((item) => item.issue.title)).toEqual(['Api']);
  });

  it('filters by wave, with null selecting the unordered issues', () => {
    const waveOne = boardItems(issues, g, { filters: { wave: 1 } });
    expect(waveOne.map((item) => item.issue.title)).toEqual(['Api']);

    const unordered = boardItems(issues, g, { filters: { wave: null } });
    expect(unordered.map((item) => item.issue.title)).toEqual(['Loop']);
  });

  it('filters by a case-insensitive substring of the title or body', () => {
    expect(
      boardItems(issues, g, { filters: { text: 'schema' } }).map((i) => i.issue.title),
    ).toEqual(['Schema']);
    expect(
      boardItems(issues, g, { filters: { text: 'endpoints' } }).map((i) => i.issue.title),
    ).toEqual(['Api']);
    expect(boardItems(issues, g, { filters: { text: 'nothing' } })).toEqual([]);
  });
});

describe('boardItems sorting', () => {
  const issues = [
    issue({ title: 'Beta', createdAt: '2026-01-03T00:00:00.000Z' }),
    issue({ title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z' }),
    issue({ title: 'Gamma', createdAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const g = graph([
    { id: 'beta', wave: 0 },
    { id: 'alpha', wave: 0 },
    { id: 'gamma', wave: 0 },
  ]);

  it('sorts by creation date', () => {
    const items = boardItems(issues, g, { sort: 'created' });
    expect(items.map((item) => item.issue.title)).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  it('sorts by title', () => {
    const items = boardItems(issues, g, { sort: 'title' });
    expect(items.map((item) => item.issue.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('spendByIssue', () => {
  it('sums the cost of every run per issue', () => {
    const spend = spendByIssue([
      { issueId: 'i1', costCents: 10 },
      { issueId: 'i2', costCents: 5 },
      { issueId: 'i1', costCents: 7 },
    ]);

    expect(spend.get('i1')).toBe(17);
    expect(spend.get('i2')).toBe(5);
    expect(spend.get('i3')).toBeUndefined();
  });
});

describe('budgetRemaining', () => {
  it('subtracts spent cents from the budget, never going below zero', () => {
    expect(budgetRemaining(issue({ title: 'A', budgetCents: 50 }), 20)).toBe(30);
    expect(budgetRemaining(issue({ title: 'B', budgetCents: 50 }), 50)).toBe(0);
    expect(budgetRemaining(issue({ title: 'C', budgetCents: 50 }), 80)).toBe(0);
    expect(budgetRemaining(issue({ title: 'D', budgetCents: 50 }), 0)).toBe(50);
  });
});

describe('pullRequestNumber', () => {
  it('reads the number off a GitHub pull request URL', () => {
    expect(pullRequestNumber('https://github.com/acme/todo-app/pull/42')).toBe(42);
  });

  it('returns null when there is no pull request', () => {
    expect(pullRequestNumber(null)).toBeNull();
  });

  it('returns null when the URL does not look like a pull request', () => {
    expect(pullRequestNumber('https://github.com/acme/todo-app')).toBeNull();
  });
});
