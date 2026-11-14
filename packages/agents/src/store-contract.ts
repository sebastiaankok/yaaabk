import type { AgentStore, StoredAgentRun } from './types';

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

/** A complete {@link StoredAgentRun}, overridable per test. */
export function runRecord(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    issueId: 'issue-1',
    attemptNumber: 1,
    jobName: null,
    pvcName: null,
    openrouterSecretName: null,
    status: 'queued',
    prUrl: null,
    logs: null,
    costCents: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    tokenHash: 'hash-1',
    ...overrides,
  };
}

/**
 * Asserts that an {@link AgentStore} implementation behaves as specified.
 *
 * Callers pass their framework's `describe`/`it`/`expect` and a factory that
 * returns a fresh, empty store.
 */
export function agentStoreContract(api: StoreTestApi, createStore: () => AgentStore): void {
  const { describe, it, expect } = api;

  describe('agent runs', () => {
    it('starts empty', () => {
      const store = createStore();

      expect(store.listForProject('project-1')).toHaveLength(0);
      expect(store.listActive()).toHaveLength(0);
      expect(store.get('run-1')).toBeUndefined();
    });

    it('stores and reads back a run by id', () => {
      const store = createStore();
      store.create(runRecord());

      expect(store.get('run-1')).toEqual(runRecord());
    });

    it('lists a project\u2019s runs newest first', () => {
      const store = createStore();
      store.create(runRecord({ id: 'run-1', createdAt: '2026-01-02T00:00:00.000Z' }));
      store.create(runRecord({ id: 'run-2', createdAt: '2026-01-01T00:00:00.000Z' }));

      expect(store.listForProject('project-1').map((run) => run.id)).toEqual(['run-1', 'run-2']);
    });

    it('lists an issue\u2019s runs oldest first', () => {
      const store = createStore();
      store.create(runRecord({ id: 'run-1', createdAt: '2026-01-02T00:00:00.000Z' }));
      store.create(runRecord({ id: 'run-2', createdAt: '2026-01-01T00:00:00.000Z' }));

      expect(store.listForIssue('project-1', 'issue-1').map((run) => run.id)).toEqual([
        'run-2',
        'run-1',
      ]);
    });

    it('lists only the in-flight runs, oldest first', () => {
      const store = createStore();
      store.create(runRecord({ id: 'run-1', status: 'queued' }));
      store.create(runRecord({ id: 'run-2', status: 'running' }));
      store.create(runRecord({ id: 'run-3', status: 'success' }));
      store.create(runRecord({ id: 'run-4', status: 'failed' }));

      expect(store.listActive().map((run) => run.id)).toEqual(['run-1', 'run-2']);
    });

    it('updates a run', () => {
      const store = createStore();
      store.create(runRecord());

      store.update(
        runRecord({
          status: 'success',
          jobName: 'agent-issue-1-attempt-1',
          pvcName: 'agent-work-issue-1-1',
          prUrl: 'https://github.com/acme/todo/pull/7',
        }),
      );

      expect(store.get('run-1')).toEqual(
        runRecord({
          status: 'success',
          jobName: 'agent-issue-1-attempt-1',
          pvcName: 'agent-work-issue-1-1',
          prUrl: 'https://github.com/acme/todo/pull/7',
        }),
      );
    });

    it('keeps the report token hash private to the store', () => {
      const store = createStore();
      store.create(runRecord({ tokenHash: 'secret-hash' }));

      expect(store.get('run-1')?.tokenHash).toBe('secret-hash');
    });

    it('throws when updating an unknown run', () => {
      const store = createStore();

      expect(() => store.update(runRecord())).toThrow();
    });
  });
}
