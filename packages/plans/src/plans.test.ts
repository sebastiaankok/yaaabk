import { describe, expect, it } from 'vitest';
import { createInMemoryPlanStore } from './in-memory-plan-store';
import { createPlansModule } from './plans';
import type { NewPlan, PlanAcceptanceFacts, PlansModule } from './types';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const INPUT: NewPlan = {
  projectId: 'project-1',
  contentMarkdown: '# Plan',
  skillLevel: 'expert',
  source: 'grill-me',
};

/** Creates a plan, failing the test if the module reports an error. */
async function create(plans: PlansModule, overrides: Partial<Record<keyof NewPlan, unknown>> = {}) {
  const result = await plans.create({ ...INPUT, ...overrides } as NewPlan);
  if (!result.ok) throw new Error(`create failed: ${result.error.message}`);
  return result.value;
}

function setup(options: { ids?: string[] } = {}) {
  const store = createInMemoryPlanStore();
  const ids = options.ids ?? ['plan-1'];
  let next = 0;
  const plans = createPlansModule({
    store,
    ids: () => ids[next++] ?? 'plan-extra',
    clock: () => NOW,
    logger: { info: () => {}, error: () => {} },
  });
  return { store, plans };
}

describe('create', () => {
  it('stores a new plan as version 1 and marks it active', async () => {
    const { store, plans } = setup();

    const result = await plans.create({
      projectId: 'project-1',
      contentMarkdown: '# Plan',
      skillLevel: 'expert',
      source: 'grill-me',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      id: 'plan-1',
      projectId: 'project-1',
      version: 1,
      contentMarkdown: '# Plan',
      skillLevel: 'expert',
      source: 'grill-me',
      createdAt: NOW.toISOString(),
      isActive: true,
    });
    expect(store.get('project-1', 'plan-1')).toEqual(result.value);
  });

  it('stores the summary the caller supplied', async () => {
    const { store, plans } = setup();

    const plan = await create(plans, {
      contentMarkdown: '# Plan\n\nFull detail.',
      summary: '  Save   and find bookmarks  ',
    });

    expect(plan.summary).toBe('Save and find bookmarks');
    expect(store.get('project-1', 'plan-1')?.summary).toBe('Save and find bookmarks');
  });

  it('derives a fallback summary from the Markdown when none is supplied', async () => {
    const { plans } = setup();

    const plan = await create(plans, {
      contentMarkdown: '## Problem Statement\n\nDevelopers lose their bookmarks.',
    });

    expect(plan.summary).toBe('Developers lose their bookmarks.');
  });

  it.each([
    ['an empty summary', { summary: '   ' }],
    ['an over-long summary', { summary: 'x'.repeat(201) }],
  ])('rejects %s', async (_label, overrides) => {
    const { plans } = setup();

    const result = await plans.create({ ...INPUT, ...overrides } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });

  it('creates a new version and deactivates the previous one', async () => {
    const { store, plans } = setup({ ids: ['plan-1', 'plan-2'] });

    await create(plans);
    const second = await create(plans, { contentMarkdown: '# Plan v2' });

    expect(second.version).toBe(2);
    expect(second.isActive).toBe(true);
    expect(store.get('project-1', 'plan-1')?.isActive).toBe(false);
    expect(store.get('project-1', 'plan-2')?.isActive).toBe(true);
  });

  it.each([
    ['an empty project id', { projectId: '   ' }],
    ['empty content', { contentMarkdown: '   ' }],
    ['an unknown skill level', { skillLevel: 'wizard' }],
    ['an unknown source', { source: 'api' }],
  ])('rejects %s', async (_label, overrides) => {
    const { plans } = setup();

    const result = await plans.create({ ...INPUT, ...overrides } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });
});

describe('list', () => {
  it('returns every version newest first', async () => {
    const { plans } = setup({ ids: ['plan-1', 'plan-2'] });

    await create(plans);
    await create(plans, { contentMarkdown: '# Plan v2' });

    const result = await plans.list('project-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((plan) => plan.version)).toEqual([2, 1]);
  });

  it('returns only the plans of the requested project', async () => {
    const { plans } = setup({ ids: ['plan-1', 'plan-2'] });

    await create(plans);
    await create(plans, { projectId: 'project-2' });

    const result = await plans.list('project-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((plan) => plan.id)).toEqual(['plan-1']);
  });
});

describe('getActive', () => {
  it('returns null when the project has no plans', async () => {
    const { plans } = setup();

    await expect(plans.getActive('project-1')).resolves.toEqual({ ok: true, value: null });
  });

  it('returns the active version', async () => {
    const { plans } = setup({ ids: ['plan-1', 'plan-2'] });

    await create(plans);
    await create(plans, { contentMarkdown: '# Plan v2' });

    const result = await plans.getActive('project-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.version).toBe(2);
  });
});

describe('activate', () => {
  it('activates an earlier version and deactivates the newer one', async () => {
    const { store, plans } = setup({ ids: ['plan-1', 'plan-2'] });

    await create(plans);
    await create(plans, { contentMarkdown: '# Plan v2' });

    const result = await plans.activate('project-1', 'plan-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isActive).toBe(true);
    expect(store.get('project-1', 'plan-2')?.isActive).toBe(false);
    expect(store.getActive('project-1')?.id).toBe('plan-1');
  });

  it('reports an unknown plan as not-found', async () => {
    const { plans } = setup();

    const result = await plans.activate('project-1', 'missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('accept', () => {
  const acceptance = (overrides: Partial<PlanAcceptanceFacts> = {}) => ({
    facts: {
      issueCount: 1,
      issues: [{ title: 'Schema', wave: 0, missing: [] }],
      ...overrides,
    },
    push: async () => ({ ok: true as const }),
  });

  it('records the accepted date for the active plan once its issues can be pushed', async () => {
    const { store, plans } = setup({ ids: ['plan-1'] });
    await create(plans);

    const result = await plans.accept('project-1', 'plan-1', {
      facts: { issueCount: 1, issues: [{ title: 'Schema', wave: 0, missing: [] }] },
      push: async () => ({ ok: true }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.acceptedAt).toBe(NOW.toISOString());
    expect(store.get('project-1', 'plan-1')?.acceptedAt).toBe(NOW.toISOString());
  });

  it('rejects a plan that is no longer the active version', async () => {
    const { store, plans } = setup({ ids: ['plan-1', 'plan-2'] });
    await create(plans);
    await create(plans, { contentMarkdown: '# Plan v2' });

    const result = await plans.accept('project-1', 'plan-1', acceptance());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-acceptable');
    expect(result.error.message).toMatch(/active/i);
    expect(store.get('project-1', 'plan-1')?.acceptedAt).toBeNull();
  });

  it('rejects a plan that was already accepted', async () => {
    const { plans } = setup({ ids: ['plan-1'] });
    await create(plans);
    const first = await plans.accept('project-1', 'plan-1', acceptance());
    expect(first.ok).toBe(true);

    const result = await plans.accept('project-1', 'plan-1', acceptance());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-acceptable');
    expect(result.error.message).toMatch(/already accepted/i);
  });

  it('rejects a plan with no issues', async () => {
    const { plans } = setup({ ids: ['plan-1'] });
    await create(plans);
    let pushed = false;

    const result = await plans.accept('project-1', 'plan-1', {
      facts: { issueCount: 0, issues: [] },
      push: async () => {
        pushed = true;
        return { ok: true };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-acceptable');
    expect(result.error.message).toMatch(/at least one issue/i);
    expect(pushed).toBe(false);
  });

  it('rejects a plan whose issues sit on a dependency cycle', async () => {
    const { plans } = setup({ ids: ['plan-1'] });
    await create(plans);
    let pushed = false;

    const result = await plans.accept('project-1', 'plan-1', {
      facts: {
        issueCount: 2,
        issues: [
          { title: 'Schema', wave: null, missing: [] },
          { title: 'Api', wave: null, missing: [] },
        ],
      },
      push: async () => {
        pushed = true;
        return { ok: true };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-acceptable');
    expect(result.error.message).toMatch(/circular/i);
    expect(result.error.message).toContain('Schema');
    expect(pushed).toBe(false);
  });

  it('rejects a plan with an unresolved dependency', async () => {
    const { plans } = setup({ ids: ['plan-1'] });
    await create(plans);
    let pushed = false;

    const result = await plans.accept('project-1', 'plan-1', {
      facts: {
        issueCount: 1,
        issues: [{ title: 'Api', wave: 0, missing: ['Ghost'] }],
      },
      push: async () => {
        pushed = true;
        return { ok: true };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-acceptable');
    expect(result.error.message).toMatch(/missing/i);
    expect(result.error.message).toContain('Ghost');
    expect(pushed).toBe(false);
  });

  it('leaves the plan unaccepted when the GitHub push fails', async () => {
    const { store, plans } = setup({ ids: ['plan-1'] });
    await create(plans);

    const result = await plans.accept('project-1', 'plan-1', {
      facts: { issueCount: 1, issues: [{ title: 'Schema', wave: 0, missing: [] }] },
      push: async () => ({ ok: false, message: 'Bad credentials' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('sync-failed');
    expect(result.error.message).toBe('Bad credentials');
    expect(store.get('project-1', 'plan-1')?.acceptedAt).toBeNull();
  });

  it('reports an unknown plan as not-found', async () => {
    const { plans } = setup();

    const result = await plans.accept('project-1', 'missing', acceptance());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('removeForProject', () => {
  it('drops every version of one project\u2019s plans', async () => {
    const { store, plans } = setup({ ids: ['plan-1', 'plan-2', 'plan-3'] });
    await create(plans);
    await create(plans, { contentMarkdown: '# Plan v2' });
    await create(plans, { projectId: 'project-2' });

    const result = await plans.removeForProject('project-1');

    expect(result.ok).toBe(true);
    expect(store.list('project-1')).toEqual([]);
    expect(store.list('project-2')).toHaveLength(1);
  });
});
