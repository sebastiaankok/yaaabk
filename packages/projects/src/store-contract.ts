import type { Project, ProjectStore } from './types';

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

/** A complete {@link Project}, overridable per test. */
export function projectRecord(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'todo-app',
    description: 'A todo list',
    skillLevel: 'expert',
    repoUrl: 'https://github.com/acme/todo-app',
    repoFullName: 'acme/todo-app',
    namespace: 'project-a1b2c3d4',
    argoAppName: 'todo-app',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Asserts that a {@link ProjectStore} implementation behaves as specified.
 *
 * Callers pass their framework's `describe`/`it`/`expect` and a factory that
 * returns a fresh, empty store.
 */
export function projectStoreContract(api: StoreTestApi, createStore: () => ProjectStore): void {
  const { describe, it, expect } = api;

  describe('projects', () => {
    it('starts empty', () => {
      expect(createStore().list()).toHaveLength(0);
    });

    it('stores and reads back a project by id', () => {
      const store = createStore();
      store.create(projectRecord());

      expect(store.get('project-1')).toEqual(projectRecord());
    });

    it('finds a project by name', () => {
      const store = createStore();
      store.create(projectRecord());

      expect(store.getByName('todo-app')).toEqual(projectRecord());
    });

    it('returns undefined for unknown projects', () => {
      const store = createStore();

      expect(store.get('missing')).toBeUndefined();
      expect(store.getByName('missing')).toBeUndefined();
    });

    it('rejects a duplicate name', () => {
      const store = createStore();
      store.create(projectRecord());

      expect(() => store.create(projectRecord({ id: 'project-2' }))).toThrow();
    });

    it('lists projects newest first', () => {
      const store = createStore();
      store.create(
        projectRecord({ id: 'older', name: 'older', createdAt: '2026-01-01T00:00:00.000Z' }),
      );
      store.create(
        projectRecord({ id: 'newer', name: 'newer', createdAt: '2026-02-01T00:00:00.000Z' }),
      );

      expect(store.list().map((project) => project.id)).toEqual(['newer', 'older']);
    });

    it('replaces a project on update', () => {
      const store = createStore();
      store.create(projectRecord());

      store.update(
        projectRecord({ description: 'Updated', updatedAt: '2026-03-01T00:00:00.000Z' }),
      );

      expect(store.get('project-1')?.description).toBe('Updated');
      expect(store.get('project-1')?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    });

    it('deletes a project by id', () => {
      const store = createStore();
      store.create(projectRecord());

      store.delete('project-1');

      expect(store.get('project-1')).toBeUndefined();
      expect(store.list()).toHaveLength(0);
    });
  });
}
