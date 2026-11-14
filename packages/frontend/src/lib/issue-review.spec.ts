import { describe, expect, it } from 'vitest';
import type { Issue, IssueGraph } from '@yaaabk/issues';
import { groupByWave, reviewItems } from './issue-review';

function issue(overrides: Partial<Issue> & { title: string }): Issue {
  return {
    id: overrides.title.toLowerCase().replace(/\s+/g, '-'),
    projectId: 'project-1',
    planId: 'plan-1',
    githubNumber: null,
    body: '',
    status: 'open',
    label: 'refinement-needed',
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

function graph(
  nodes: Array<{ id: string; title: string; wave: number | null; missing?: string[] }>,
): IssueGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      dependsOn: [],
      missing: node.missing ?? [],
      wave: node.wave,
    })),
    cycles: [],
  };
}

describe('reviewItems', () => {
  it('orders issues by wave', () => {
    const schema = issue({ title: 'Schema' });
    const api = issue({ title: 'Api', createdAt: '2026-01-02T00:00:00.000Z' });
    const items = reviewItems(
      [api, schema],
      graph([
        { id: 'api', title: 'Api', wave: 1 },
        { id: 'schema', title: 'Schema', wave: 0 },
      ]),
    );

    expect(items.map((item) => item.issue.title)).toEqual(['Schema', 'Api']);
  });

  it('keeps creation order within a wave', () => {
    const first = issue({ title: 'First' });
    const second = issue({ title: 'Second', createdAt: '2026-01-02T00:00:00.000Z' });
    const items = reviewItems(
      [second, first],
      graph([
        { id: 'first', title: 'First', wave: 0 },
        { id: 'second', title: 'Second', wave: 0 },
      ]),
    );

    expect(items.map((item) => item.issue.title)).toEqual(['First', 'Second']);
  });

  it('places issues on a cycle after the waved ones', () => {
    const loop = issue({ title: 'Loop' });
    const schema = issue({ title: 'Schema' });
    const items = reviewItems(
      [loop, schema],
      graph([
        { id: 'loop', title: 'Loop', wave: null },
        { id: 'schema', title: 'Schema', wave: 0 },
      ]),
    );

    expect(items.map((item) => [item.issue.title, item.wave])).toEqual([
      ['Schema', 0],
      ['Loop', null],
    ]);
  });

  it('carries the unresolved dependency titles', () => {
    const api = issue({ title: 'Api' });
    const items = reviewItems(
      [api],
      graph([{ id: 'api', title: 'Api', wave: 0, missing: ['Ghost'] }]),
    );

    expect(items[0]?.missing).toEqual(['Ghost']);
  });
});

describe('groupByWave', () => {
  it('groups consecutive items of the same wave', () => {
    const schema = issue({ title: 'Schema' });
    const api = issue({ title: 'Api' });
    const ui = issue({ title: 'Ui' });
    const items = reviewItems(
      [schema, api, ui],
      graph([
        { id: 'schema', title: 'Schema', wave: 0 },
        { id: 'api', title: 'Api', wave: 1 },
        { id: 'ui', title: 'Ui', wave: 1 },
      ]),
    );

    expect(groupByWave(items).map((group) => [group.wave, group.items.length])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});
