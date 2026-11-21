import { describe, expect, it } from 'vitest';
import type { Issue, IssueGraph } from '@yaaabk/issues';
import {
  boardChips,
  boardColumn,
  boardItems,
  boardView,
  budgetRemaining,
  dependencyEdges,
  issueIdFromParam,
  pullRequestNumber,
  spendByIssue,
  withoutChip,
} from './issue-board';

function issue(overrides: Partial<Issue> & { title: string }): Issue {
  return {
    id: overrides.title.toLowerCase().replace(/\s+/g, '-'),
    projectId: 'project-1',
    planId: 'plan-1',
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

describe('boardItems scope', () => {
  const issues = [
    issue({ title: 'Schema', planId: 'plan-1' }),
    issue({ title: 'Done', planId: 'plan-1', status: 'closed' }),
    issue({ title: 'Older', planId: 'plan-0', createdAt: '2026-01-02T00:00:00.000Z' }),
    issue({ title: 'Manual', planId: null, createdAt: '2026-01-03T00:00:00.000Z' }),
  ];
  const g = graph([
    { id: 'schema', wave: 0 },
    { id: 'done', wave: 0 },
    { id: 'older', wave: 0 },
    { id: 'manual', wave: 0 },
  ]);

  it('shows closed issues unless told not to', () => {
    expect(boardItems(issues, g).map((item) => item.issue.title)).toContain('Done');
    expect(boardItems(issues, g, { includeClosed: false }).map((item) => item.issue.title)).toEqual(
      ['Schema', 'Older', 'Manual'],
    );
  });

  it('narrows to one plan', () => {
    const scoped = boardItems(issues, g, { planId: 'plan-1', includeClosed: false });

    expect(scoped.map((item) => item.issue.title)).toEqual(['Schema']);
  });

  it('selects the issues that have no plan', () => {
    const manual = boardItems(issues, g, { planId: null });

    expect(manual.map((item) => item.issue.title)).toEqual(['Manual']);
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

  it('filters by a case-insensitive substring of the title, summary or body', () => {
    expect(
      boardItems(issues, g, { filters: { text: 'schema' } }).map((i) => i.issue.title),
    ).toEqual(['Schema']);
    expect(
      boardItems(issues, g, { filters: { text: 'endpoints' } }).map((i) => i.issue.title),
    ).toEqual(['Api']);
    expect(boardItems(issues, g, { filters: { text: 'nothing' } })).toEqual([]);
  });

  it('matches summary text, including a derived fallback for an older row', () => {
    const withSummaries = [
      issue({ title: 'Schema', summary: 'Create the bookmark tables.' }),
      issue({ title: 'Fallback', summary: null, body: 'Build a searchable list.' }),
    ];
    const graphWithSummaries = graph([
      { id: 'schema', wave: 0 },
      { id: 'fallback', wave: 1 },
    ]);

    expect(
      boardItems(withSummaries, graphWithSummaries, { filters: { text: 'bookmark tables' } }).map(
        (item) => item.issue.title,
      ),
    ).toEqual(['Schema']);
    expect(
      boardItems(withSummaries, graphWithSummaries, { filters: { text: 'searchable' } }).map(
        (item) => item.issue.title,
      ),
    ).toEqual(['Fallback']);
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

describe('issueIdFromParam', () => {
  const issues = [issue({ title: 'Schema' }), issue({ title: 'Api' })];

  it('finds the Issue named in the query parameter', () => {
    expect(issueIdFromParam('api', issues)).toBe('api');
  });

  it('ignores an unknown id', () => {
    expect(issueIdFromParam('nope', issues)).toBeNull();
  });

  it('returns null when the parameter is absent or empty', () => {
    expect(issueIdFromParam(null, issues)).toBeNull();
    expect(issueIdFromParam('', issues)).toBeNull();
  });
});

describe('boardView filters', () => {
  const issues = [
    issue({ title: 'Schema', label: 'ready', summary: 'Create the tables.' }),
    issue({
      title: 'Api',
      label: 'blocked',
      body: 'Build the endpoints',
      createdAt: '2026-01-02T00:00:00.000Z',
    }),
    issue({
      title: 'Refine',
      label: 'refinement-needed',
      createdAt: '2026-01-03T00:00:00.000Z',
    }),
    issue({ title: 'Loop', createdAt: '2026-01-04T00:00:00.000Z' }),
  ];
  const g = graph([
    { id: 'schema', wave: 0 },
    { id: 'api', wave: 1 },
    { id: 'refine', wave: 1 },
    { id: 'loop', wave: null },
  ]);
  const activePlan = { id: 'plan-1', version: 1 };

  it('combines text, label, lane and wave', () => {
    const view = boardView(issues, g, {
      activePlan,
      filters: { text: 'endpoints', label: 'blocked', column: 'blocked', wave: 1 },
    });

    expect(view.items.map((item) => item.issue.title)).toEqual(['Api']);
    expect(view.count).toBe(1);
    expect(view.total).toBe(4);
  });

  it('lets any one filter narrow the same board', () => {
    const one = (filters: NonNullable<Parameters<typeof boardView>[2]>['filters']) =>
      boardView(issues, g, { activePlan, filters }).items.map((item) => item.issue.title);

    expect(one({ text: 'refine' })).toEqual(['Refine']);
    expect(one({ label: 'refinement-needed' })).toEqual(['Refine']);
    expect(one({ column: 'ready' })).toEqual(['Schema', 'Refine', 'Loop']);
    expect(one({ wave: null })).toEqual(['Loop']);
  });

  it('generates one chip per active filter and ignores blank search text', () => {
    expect(boardChips({})).toEqual([]);
    expect(boardChips({ text: '   ' })).toEqual([]);
    expect(boardChips({ text: 'api', label: 'blocked', column: 'blocked', wave: null })).toEqual([
      { kind: 'text', label: 'Search: api', value: 'api' },
      { kind: 'label', label: 'Label: blocked', value: 'blocked' },
      { kind: 'column', label: 'Lane: Blocked', value: 'blocked' },
      { kind: 'wave', label: 'Unordered', value: null },
    ]);
  });

  it('removes exactly the chip filter and leaves the rest alone', () => {
    const filters = { text: 'api', label: 'blocked' as const, column: 'blocked' as const, wave: 1 };
    const [text, label, column, wave] = boardChips(filters);

    expect(text && withoutChip(filters, text)).toEqual({
      label: 'blocked',
      column: 'blocked',
      wave: 1,
    });
    expect(label && withoutChip(filters, label)).toEqual({
      text: 'api',
      column: 'blocked',
      wave: 1,
    });
    expect(column && withoutChip(filters, column)).toEqual({
      text: 'api',
      label: 'blocked',
      wave: 1,
    });
    expect(wave && withoutChip(filters, wave)).toEqual({
      text: 'api',
      label: 'blocked',
      column: 'blocked',
    });
  });

  it('restores the cards a removed chip was hiding', () => {
    const filters = { column: 'ready' as const, label: 'refinement-needed' as const };
    expect(
      boardView(issues, g, { activePlan, filters }).items.map((item) => item.issue.title),
    ).toEqual(['Refine']);

    const labelChip = boardChips(filters).find((chip) => chip.kind === 'label');
    expect(labelChip).toBeDefined();
    const restored = boardView(issues, g, {
      activePlan,
      filters: labelChip === undefined ? filters : withoutChip(filters, labelChip),
    });

    expect(restored.items.map((item) => item.issue.title)).toEqual(['Schema', 'Refine', 'Loop']);
    expect(restored.chips.map((chip) => chip.label)).toEqual(['Lane: Ready']);
  });
});

describe('boardView plan scope', () => {
  const issues = [
    issue({ title: 'Current', planId: 'plan-1' }),
    issue({ title: 'Legacy', planId: 'plan-0', createdAt: '2026-01-02T00:00:00.000Z' }),
    issue({
      title: 'Manual',
      planId: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    }),
    issue({
      title: 'Old closed',
      planId: 'plan-0',
      status: 'closed',
      createdAt: '2026-01-04T00:00:00.000Z',
    }),
  ];
  const g = graph([
    { id: 'current', wave: 0 },
    { id: 'legacy', wave: 0 },
    { id: 'manual', wave: 0 },
    { id: 'old-closed', wave: 0 },
  ]);
  const activePlan = { id: 'plan-1', version: 2 };

  it('follows the active Plan and reports the open earlier-Plan work it hides', () => {
    const view = boardView(issues, g, { activePlan });

    expect(view.items.map((item) => item.issue.title)).toEqual(['Current']);
    expect(view.earlierWork.map((work) => work.title)).toEqual(['Legacy', 'Manual']);
  });

  it('shows every Plan and stops warning once earlier Plans are shown', () => {
    const view = boardView(issues, g, { activePlan, showEarlierPlans: true });

    expect(view.items.map((item) => item.issue.title)).toEqual(['Current', 'Legacy', 'Manual']);
    expect(view.earlierWork).toEqual([]);
  });

  it('does not scope or warn when the Project has no Plan', () => {
    const view = boardView(issues, g, { activePlan: null });

    expect(view.items.map((item) => item.issue.title)).toEqual(['Current', 'Legacy', 'Manual']);
    expect(view.earlierWork).toEqual([]);
  });

  it('offers the graph waves and unordered option for the filter', () => {
    const view = boardView(issues, g, {
      activePlan,
      filters: {},
    });

    expect(view.waves).toEqual([0]);
    expect(view.hasUnordered).toBe(false);
  });
});

describe('boardView lanes', () => {
  const issues = [
    issue({ title: 'Schema', label: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }),
    issue({ title: 'Api', label: 'blocked', createdAt: '2026-01-02T00:00:00.000Z' }),
    issue({ title: 'Auth', status: 'in_progress', createdAt: '2026-01-03T00:00:00.000Z' }),
    issue({ title: 'Scaffold', status: 'closed', createdAt: '2026-01-04T00:00:00.000Z' }),
    issue({ title: 'Deploy', status: 'failed', createdAt: '2026-01-05T00:00:00.000Z' }),
  ];
  const g = graph([
    { id: 'schema', wave: 0 },
    { id: 'api', wave: 1 },
    { id: 'auth', wave: 0 },
    { id: 'scaffold', wave: 0 },
    { id: 'deploy', wave: 2 },
  ]);
  const activePlan = { id: 'plan-1', version: 1 };

  it('returns every lane with its cards, count and visibility', () => {
    const view = boardView(issues, g, { activePlan });

    expect(view.lanes.map((lane) => [lane.column, lane.visible, lane.count])).toEqual([
      ['ready', true, 1],
      ['blocked', true, 1],
      ['in_progress', true, 1],
      ['closed', false, 0],
      ['failed', true, 1],
    ]);
    expect(view.lanes[0]?.items.map((item) => item.issue.title)).toEqual(['Schema']);
    expect(view.count).toBe(4);
    expect(view.total).toBe(4);
  });

  it('keeps empty lanes in the model so the page can explain them', () => {
    const view = boardView(issues, g, {
      activePlan,
      filters: { wave: 2 },
    });

    expect(view.lanes.map((lane) => [lane.column, lane.count])).toEqual([
      ['ready', 0],
      ['blocked', 0],
      ['in_progress', 0],
      ['closed', 0],
      ['failed', 1],
    ]);
    expect(view.lanes.filter((lane) => lane.visible).map((lane) => lane.column)).toEqual([
      'ready',
      'blocked',
      'in_progress',
      'failed',
    ]);
  });

  it('makes the closed lane visible only when history is shown', () => {
    expect(
      boardView(issues, g, { activePlan }).lanes.find((lane) => lane.column === 'closed')?.visible,
    ).toBe(false);

    const history = boardView(issues, g, { activePlan, showClosed: true });

    expect(history.lanes.find((lane) => lane.column === 'closed')?.visible).toBe(true);
    expect(history.lanes.find((lane) => lane.column === 'closed')?.count).toBe(1);
    expect(history.total).toBe(5);
  });

  it('makes the closed lane visible when the lane filter asks for it', () => {
    const view = boardView(issues, g, {
      activePlan,
      filters: { column: 'closed' },
    });

    expect(view.lanes.find((lane) => lane.column === 'closed')?.visible).toBe(true);
    expect(view.lanes.find((lane) => lane.column === 'closed')?.items).toHaveLength(1);
    expect(view.count).toBe(1);
  });
});
