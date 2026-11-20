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
    toBeNull(): void;
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
    kind: 'implement-issue',
    attemptNumber: 1,
    pullNumber: null,
    commitSha: null,
    jobName: null,
    pvcName: null,
    openrouterSecretName: null,
    branch: null,
    reviewFeedback: null,
    status: 'queued',
    model: null,
    prUrl: null,
    reviewVerdict: null,
    reviewBody: null,
    logs: null,
    costCents: 0,
    tokens: null,
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

    it('stores and reads back a review run with its pull number', () => {
      const store = createStore();
      const review = runRecord({ kind: 'review', pullNumber: 7, attemptNumber: 2 });

      store.create(review);

      expect(store.get('run-1')).toEqual(review);
    });

    it('stores and reads back a deploy run with its commit SHA', () => {
      const store = createStore();
      const deploy = runRecord({ kind: 'deploy', commitSha: 'abc123', attemptNumber: 1 });

      store.create(deploy);

      expect(store.get('run-1')).toEqual(deploy);
    });

    it('stores a fix attempt with its reviewer feedback', () => {
      const store = createStore();
      const fix = runRecord({
        branch: 'agent/issue-42',
        reviewFeedback: 'Please rename the helper.',
      });

      store.create(fix);

      expect(store.get('run-1')).toEqual(fix);
    });

    it('stores the model resolved for the attempt', () => {
      const store = createStore();
      const running = runRecord({
        status: 'running',
        model: 'openrouter/anthropic/claude-sonnet-4.5',
      });

      store.create(running);

      expect(store.get('run-1')?.model).toBe('openrouter/anthropic/claude-sonnet-4.5');
    });

    it('stores measured token usage and keeps unmeasured runs null', () => {
      const store = createStore();
      const tokens = {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 300, write: 10 },
      };
      store.create(runRecord({ id: 'measured', tokens }));
      store.create(runRecord({ id: 'unmeasured', tokens: null }));

      expect(store.get('measured')?.tokens).toEqual(tokens);
      expect(store.get('unmeasured')?.tokens).toBeNull();
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
