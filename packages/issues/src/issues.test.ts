import { describe, expect, it } from 'vitest';
import { createInMemoryIssueStore } from './in-memory-issue-store';
import { createIssuesModule } from './issues';
import type { IssuesModule } from './types';

const NOW = new Date('2026-01-01T12:00:00.000Z');

function setup(options: { ids?: string[]; defaultBudgetCents?: number } = {}) {
  const store = createInMemoryIssueStore();
  const ids = options.ids ?? ['issue-1'];
  let next = 0;
  const issues = createIssuesModule({
    store,
    ids: () => ids[next++] ?? 'issue-extra',
    clock: () => NOW,
    logger: { info: () => {}, error: () => {} },
    ...(options.defaultBudgetCents === undefined
      ? {}
      : { defaultBudgetCents: options.defaultBudgetCents }),
  });
  return { store, issues };
}

/** Creates an issue, failing the test if the module reports an error. */
async function create(issues: IssuesModule, overrides: Partial<Record<string, unknown>> = {}) {
  const result = await issues.create({
    projectId: 'project-1',
    title: 'Add login',
    ...overrides,
  } as never);
  if (!result.ok) throw new Error(`create failed: ${result.error.message}`);
  return result.value;
}

describe('create', () => {
  it('stores a new issue with workflow defaults', async () => {
    const { store, issues } = setup();

    const result = await issues.create({ projectId: 'project-1', title: 'Add login' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      id: 'issue-1',
      projectId: 'project-1',
      planId: null,
      githubNumber: null,
      title: 'Add login',
      body: '',
      status: 'open',
      label: 'ready',
      dependsOn: [],
      attemptCount: 0,
      maxAttempts: 3,
      budgetCents: 50,
      openrouterKeyHash: null,
      closedAt: null,
      createdAt: NOW.toISOString(),
    });
    expect(store.get('project-1', 'issue-1')).toEqual(result.value);
  });

  it('honours the fields a caller provides', async () => {
    const { issues } = setup();

    const issue = await create(issues, {
      planId: 'plan-1',
      title: '  Add login  ',
      body: 'Details',
      label: 'blocked',
      dependsOn: ['Schema'],
      budgetCents: 120,
      maxAttempts: 5,
    });

    expect(issue).toMatchObject({
      planId: 'plan-1',
      title: 'Add login',
      body: 'Details',
      label: 'blocked',
      dependsOn: ['Schema'],
      budgetCents: 120,
      maxAttempts: 5,
    });
  });

  it('uses the configured default budget', async () => {
    const { issues } = setup({ defaultBudgetCents: 75 });

    const issue = await create(issues);

    expect(issue.budgetCents).toBe(75);
  });

  it.each([
    ['a blank project id', { projectId: '   ' }],
    ['a blank title', { title: '   ' }],
    ['an unknown label', { label: 'urgent' }],
    ['a zero budget', { budgetCents: 0 }],
    ['a budget above the cap', { budgetCents: 501 }],
    ['a fractional budget', { budgetCents: 12.5 }],
    ['a zero attempt cap', { maxAttempts: 0 }],
    ['non-string dependencies', { dependsOn: [1] }],
  ])('rejects %s', async (_label, overrides) => {
    const { issues } = setup();

    const result = await issues.create({
      projectId: 'project-1',
      title: 'Add login',
      ...overrides,
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });

  it('rejects a duplicate title within a project', async () => {
    const { issues } = setup({ ids: ['issue-1', 'issue-2'] });
    await create(issues);

    const result = await issues.create({ projectId: 'project-1', title: 'Add login' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('duplicate-title');
  });

  it('allows the same title in a different project', async () => {
    const { issues } = setup({ ids: ['issue-1', 'issue-2'] });
    await create(issues);

    const result = await issues.create({ projectId: 'project-2', title: 'Add login' });

    expect(result.ok).toBe(true);
  });
});

describe('list', () => {
  it('returns only the issues of the requested project, oldest first', async () => {
    const { issues } = setup({ ids: ['issue-1', 'issue-2', 'issue-3'] });
    await create(issues, { title: 'First' });
    await create(issues, { title: 'Second' });
    await create(issues, { projectId: 'project-2', title: 'Elsewhere' });

    const result = await issues.list('project-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((issue) => issue.title)).toEqual(['First', 'Second']);
  });
});

describe('get', () => {
  it('returns the issue', async () => {
    const { issues } = setup();
    const created = await create(issues);

    const result = await issues.get('project-1', created.id);

    expect(result).toEqual({ ok: true, value: created });
  });

  it('reports an issue from another project as not-found', async () => {
    const { issues } = setup();
    const created = await create(issues);

    const result = await issues.get('project-2', created.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('update', () => {
  it('applies the provided fields and leaves the rest', async () => {
    const { store, issues } = setup();
    const created = await create(issues);

    const result = await issues.update('project-1', created.id, {
      title: 'Add signup',
      label: 'blocked',
      status: 'in_progress',
      dependsOn: ['Schema'],
      githubNumber: 42,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      title: 'Add signup',
      label: 'blocked',
      status: 'in_progress',
      dependsOn: ['Schema'],
      githubNumber: 42,
      body: '',
      attemptCount: 0,
    });
    expect(store.get('project-1', created.id)).toEqual(result.value);
  });

  it('rejects an unknown label', async () => {
    const { issues } = setup();
    const created = await create(issues);

    const result = await issues.update('project-1', created.id, { label: 'urgent' } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });

  it('reports an unknown issue as not-found', async () => {
    const { issues } = setup();

    const result = await issues.update('project-1', 'missing', { title: 'X' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('remove', () => {
  it('deletes the issue', async () => {
    const { store, issues } = setup();
    const created = await create(issues);

    const result = await issues.remove('project-1', created.id);

    expect(result.ok).toBe(true);
    expect(store.get('project-1', created.id)).toBeUndefined();
  });

  it('reports an unknown issue as not-found', async () => {
    const { issues } = setup();

    const result = await issues.remove('project-1', 'missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('replaceForPlan', () => {
  const GENERATED = [
    { title: 'Schema', body: 'Tables', labels: ['ready'], depends_on: [] },
    { title: 'Api', body: 'Endpoints', labels: ['refinement-needed'], depends_on: ['Schema'] },
  ];

  it('records one issue per generated entry, linked to the plan', async () => {
    const { store, issues } = setup({ ids: ['issue-1', 'issue-2'] });

    const result = await issues.replaceForPlan('project-1', 'plan-1', GENERATED);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject([
      {
        id: 'issue-1',
        title: 'Schema',
        body: 'Tables',
        label: 'ready',
        planId: 'plan-1',
        dependsOn: [],
      },
      {
        id: 'issue-2',
        title: 'Api',
        body: 'Endpoints',
        label: 'refinement-needed',
        planId: 'plan-1',
        dependsOn: ['Schema'],
      },
    ]);
    expect(store.list('project-1')).toHaveLength(2);
  });

  it('defaults the label when the skill emits none it recognises', async () => {
    const { issues } = setup();

    const result = await issues.replaceForPlan('project-1', 'plan-1', [
      { title: 'Schema', body: '', labels: ['urgent'], depends_on: [] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.label).toBe('refinement-needed');
  });

  it('replaces the plan\u2019s previous drafts rather than accumulating', async () => {
    const { issues } = setup({ ids: ['issue-1', 'issue-2', 'issue-3'] });

    await issues.replaceForPlan('project-1', 'plan-1', GENERATED);
    const second = await issues.replaceForPlan('project-1', 'plan-1', [
      { title: 'Schema v2', body: '', labels: ['ready'], depends_on: [] },
    ]);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const listed = await issues.list('project-1');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((issue) => issue.title)).toEqual(['Schema v2']);
  });

  it('keeps drafts belonging to another plan', async () => {
    const { issues } = setup({ ids: ['issue-1', 'issue-2'] });

    await issues.replaceForPlan('project-1', 'plan-1', GENERATED);
    await issues.replaceForPlan('project-1', 'plan-2', [
      { title: 'Other', body: '', labels: ['ready'], depends_on: [] },
    ]);

    const listed = await issues.list('project-1');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((issue) => issue.title)).toEqual(['Schema', 'Api', 'Other']);
  });

  it('rejects a generated entry without a title', async () => {
    const { issues } = setup();

    const result = await issues.replaceForPlan('project-1', 'plan-1', [
      { title: '  ', body: '', labels: [], depends_on: [] },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });
});

describe('graph', () => {
  it('returns the dependency graph for the project', async () => {
    const { issues } = setup({ ids: ['issue-1', 'issue-2'] });
    await issues.replaceForPlan('project-1', 'plan-1', [
      { title: 'Schema', body: '', labels: ['ready'], depends_on: [] },
      { title: 'Api', body: '', labels: ['ready'], depends_on: ['Schema'] },
    ]);

    const result = await issues.graph('project-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.map((node) => [node.title, node.wave])).toEqual([
      ['Schema', 0],
      ['Api', 1],
    ]);
  });
});

describe('approve', () => {
  it('marks every issue in the project ready', async () => {
    const { store, issues } = setup({ ids: ['issue-1', 'issue-2'] });
    await create(issues, { title: 'First', label: 'refinement-needed' });
    await create(issues, { title: 'Second', label: 'blocked' });

    const result = await issues.approve('project-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((issue) => issue.label)).toEqual(['ready', 'ready']);
    expect(store.get('project-1', 'issue-1')?.label).toBe('ready');
  });
});
