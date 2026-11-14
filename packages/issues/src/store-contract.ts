import type { Issue, IssueStore } from './types';

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

/** A complete {@link Issue}, overridable per test. */
export function issueRecord(overrides: Partial<Issue> = {}): Issue {
  return {
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
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Asserts that an {@link IssueStore} implementation behaves as specified.
 *
 * Callers pass their framework's `describe`/`it`/`expect` and a factory that
 * returns a fresh, empty store.
 */
export function issueStoreContract(api: StoreTestApi, createStore: () => IssueStore): void {
  const { describe, it, expect } = api;

  describe('issues', () => {
    it('starts empty', () => {
      const store = createStore();

      expect(store.list('project-1')).toHaveLength(0);
      expect(store.get('project-1', 'issue-1')).toBeUndefined();
    });

    it('stores and reads back an issue by id', () => {
      const store = createStore();
      store.create(issueRecord());

      expect(store.get('project-1', 'issue-1')).toEqual(issueRecord());
    });

    it('does not return an issue from another project', () => {
      const store = createStore();
      store.create(issueRecord());

      expect(store.get('project-2', 'issue-1')).toBeUndefined();
    });

    it('lists a project\u2019s issues oldest first', () => {
      const store = createStore();
      store.create(
        issueRecord({ id: 'issue-1', title: 'First', createdAt: '2026-01-02T00:00:00.000Z' }),
      );
      store.create(
        issueRecord({ id: 'issue-2', title: 'Second', createdAt: '2026-01-01T00:00:00.000Z' }),
      );

      expect(store.list('project-1').map((issue) => issue.title)).toEqual(['Second', 'First']);
    });

    it('rejects a duplicate title within a project', () => {
      const store = createStore();
      store.create(issueRecord());

      expect(() => store.create(issueRecord({ id: 'issue-2' }))).toThrow();
    });

    it('allows the same title in another project', () => {
      const store = createStore();
      store.create(issueRecord());
      store.create(issueRecord({ id: 'issue-2', projectId: 'project-2' }));

      expect(store.list('project-2')).toHaveLength(1);
    });

    it('updates an issue', () => {
      const store = createStore();
      store.create(issueRecord());

      store.update(issueRecord({ title: 'Add signup', status: 'closed', dependsOn: ['Schema'] }));

      expect(store.get('project-1', 'issue-1')).toEqual(
        issueRecord({ title: 'Add signup', status: 'closed', dependsOn: ['Schema'] }),
      );
    });

    it('deletes an issue', () => {
      const store = createStore();
      store.create(issueRecord());

      store.delete('project-1', 'issue-1');

      expect(store.get('project-1', 'issue-1')).toBeUndefined();
    });

    it('throws when updating an unknown issue', () => {
      const store = createStore();

      expect(() => store.update(issueRecord())).toThrow();
    });

    it('throws when deleting an unknown issue', () => {
      const store = createStore();

      expect(() => store.delete('project-1', 'issue-1')).toThrow();
    });
  });
}
