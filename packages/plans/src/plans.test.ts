import { describe, expect, it } from 'vitest';
import { createInMemoryPlanStore } from './in-memory-plan-store';
import { createPlansModule } from './plans';
import type { NewPlan, PlansModule } from './types';

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
