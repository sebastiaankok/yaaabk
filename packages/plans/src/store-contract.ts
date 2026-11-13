import type { Plan, PlanStore } from './types';

/**
 * The minimal test-framework surface the store contract needs.
 *
 * Declaring it structurally lets the same suite run under both vitest (the
 * in-memory store) and `bun:test` (the SQLite store), so the two adapters are
 * held to identical behaviour without duplicating the assertions.
 */
export interface StoreTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void): void;
  expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toHaveLength(length: number): void;
    toThrow(): void;
  };
}

/** A complete {@link Plan}, overridable per test. */
export function planRecord(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    contentMarkdown: '# Plan',
    skillLevel: 'expert',
    source: 'grill-me',
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
    ...overrides,
  };
}

/**
 * Asserts that a {@link PlanStore} implementation behaves as specified.
 *
 * Callers pass their framework's `describe`/`it`/`expect` and a factory that
 * returns a fresh, empty store.
 */
export function planStoreContract(api: StoreTestApi, createStore: () => PlanStore): void {
  const { describe, it, expect } = api;

  describe('plans', () => {
    it('starts empty', () => {
      const store = createStore();

      expect(store.list('project-1')).toHaveLength(0);
      expect(store.getActive('project-1')).toBeUndefined();
      expect(store.nextVersion('project-1')).toBe(1);
    });

    it('stores and reads back a plan by id', () => {
      const store = createStore();
      store.create(planRecord());

      expect(store.get('project-1', 'plan-1')).toEqual(planRecord());
    });

    it('does not return a plan from another project', () => {
      const store = createStore();
      store.create(planRecord());

      expect(store.get('project-2', 'plan-1')).toBeUndefined();
    });

    it('lists versions newest first', () => {
      const store = createStore();
      store.create(planRecord({ id: 'plan-1', version: 1 }));
      store.create(planRecord({ id: 'plan-2', version: 2 }));

      expect(store.list('project-1').map((plan) => plan.version)).toEqual([2, 1]);
    });

    it('computes the next version per project', () => {
      const store = createStore();
      store.create(planRecord({ id: 'plan-1', version: 1 }));
      store.create(planRecord({ id: 'plan-2', version: 2 }));

      expect(store.nextVersion('project-1')).toBe(3);
      expect(store.nextVersion('project-2')).toBe(1);
    });

    it('deactivates the previous version when a new active plan is created', () => {
      const store = createStore();
      store.create(planRecord({ id: 'plan-1', version: 1 }));
      store.create(planRecord({ id: 'plan-2', version: 2 }));

      expect(store.get('project-1', 'plan-1')?.isActive).toBe(false);
      expect(store.get('project-1', 'plan-2')?.isActive).toBe(true);
      expect(store.getActive('project-1')?.id).toBe('plan-2');
    });

    it('activates an earlier version and deactivates the others', () => {
      const store = createStore();
      store.create(planRecord({ id: 'plan-1', version: 1 }));
      store.create(planRecord({ id: 'plan-2', version: 2 }));

      store.activate('project-1', 'plan-1');

      expect(store.get('project-1', 'plan-1')?.isActive).toBe(true);
      expect(store.get('project-1', 'plan-2')?.isActive).toBe(false);
      expect(store.getActive('project-1')?.id).toBe('plan-1');
    });

    it('throws when activating an unknown plan', () => {
      const store = createStore();

      expect(() => store.activate('project-1', 'missing')).toThrow();
    });

    it('rejects a duplicate version', () => {
      const store = createStore();
      store.create(planRecord());

      expect(() => store.create(planRecord({ id: 'plan-2' }))).toThrow();
    });
  });
}
