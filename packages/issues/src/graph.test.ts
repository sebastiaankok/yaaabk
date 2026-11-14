import { describe, expect, it } from 'vitest';
import { buildIssueGraph } from './graph';
import type { Issue } from './types';

/** A complete {@link Issue}, overridable per test. */
function issue(overrides: Partial<Issue> & { title: string }): Issue {
  return {
    id: overrides.title.toLowerCase().replace(/\s+/g, '-'),
    projectId: 'project-1',
    planId: null,
    githubNumber: null,
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

function waveOf(graph: ReturnType<typeof buildIssueGraph>, title: string): number | null {
  return graph.nodes.find((node) => node.title === title)?.wave ?? null;
}

describe('buildIssueGraph', () => {
  it('gives a dependency-free issue wave 0', () => {
    const graph = buildIssueGraph([issue({ title: 'Schema' })]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ title: 'Schema', dependsOn: [], missing: [], wave: 0 });
  });

  it('increments the wave along a dependency chain', () => {
    const graph = buildIssueGraph([
      issue({ title: 'Schema' }),
      issue({ title: 'Api', dependsOn: ['Schema'] }),
      issue({ title: 'Ui', dependsOn: ['Api'] }),
    ]);

    expect([waveOf(graph, 'Schema'), waveOf(graph, 'Api'), waveOf(graph, 'Ui')]).toEqual([0, 1, 2]);
  });

  it('assigns a diamond its longest path', () => {
    const graph = buildIssueGraph([
      issue({ title: 'Schema' }),
      issue({ title: 'Api', dependsOn: ['Schema'] }),
      issue({ title: 'Ui', dependsOn: ['Schema'] }),
      issue({ title: 'Ship', dependsOn: ['Api', 'Ui'] }),
    ]);

    expect(waveOf(graph, 'Ship')).toBe(2);
  });

  it('resolves dependency titles to ids', () => {
    const graph = buildIssueGraph([
      issue({ title: 'Schema' }),
      issue({ title: 'Api', dependsOn: ['Schema'] }),
    ]);

    const api = graph.nodes.find((node) => node.title === 'Api');
    expect(api?.dependsOn).toEqual(['schema']);
  });

  it('reports a dependency that matches no issue and treats it as no dependency', () => {
    const graph = buildIssueGraph([issue({ title: 'Api', dependsOn: ['Ghost'] })]);

    expect(graph.nodes[0]).toMatchObject({ dependsOn: [], missing: ['Ghost'], wave: 0 });
  });

  it('detects a two-issue cycle and leaves both waves undefined', () => {
    const graph = buildIssueGraph([
      issue({ title: 'A', dependsOn: ['B'] }),
      issue({ title: 'B', dependsOn: ['A'] }),
    ]);

    expect(graph.cycles).toEqual([['a', 'b']]);
    expect([waveOf(graph, 'A'), waveOf(graph, 'B')]).toEqual([null, null]);
  });

  it('detects a self-dependency', () => {
    const graph = buildIssueGraph([issue({ title: 'Loop', dependsOn: ['Loop'] })]);

    expect(graph.cycles).toEqual([['loop']]);
    expect(waveOf(graph, 'Loop')).toBeNull();
  });

  it('leaves an issue that depends on a cycle without a wave', () => {
    const graph = buildIssueGraph([
      issue({ title: 'A', dependsOn: ['B'] }),
      issue({ title: 'B', dependsOn: ['A'] }),
      issue({ title: 'Downstream', dependsOn: ['A'] }),
    ]);

    expect(waveOf(graph, 'Downstream')).toBeNull();
  });

  it('reports no cycles for a valid graph', () => {
    const graph = buildIssueGraph([
      issue({ title: 'Schema' }),
      issue({ title: 'Api', dependsOn: ['Schema'] }),
    ]);

    expect(graph.cycles).toEqual([]);
  });
});
