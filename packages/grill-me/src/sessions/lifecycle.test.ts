import { createInMemoryIssueStore, createIssuesModule } from '@yaaabk/issues';
import { createInMemoryPlanStore, createPlansModule } from '@yaaabk/plans';
import { describe, expect, it } from 'vitest';
import { createFakeSessionKeys, createFakeSessionRuntime } from './fake-runtime';
import {
  createGrillSessionsModule,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_MAX_MS,
  type GrillSessionRecord,
  type StartGrillSessionInput,
} from './session';
import { createInMemoryGrillSessionStore, type GrillSessionStore } from './store';

const INPUT: StartGrillSessionInput = {
  projectId: 'p1',
  projectName: 'todo-app',
  idea: 'A todo app',
  skillLevel: 'expert',
};

const PRD = '# Todo app\n\nA plan.';
const ISSUES = [
  {
    title: 'Add a todo',
    body: 'Persist it.',
    summary: 'Add a todo and persist it.',
    labels: ['ready'],
    depends_on: [],
  },
];

interface Setup {
  store: GrillSessionStore;
  runtime: ReturnType<typeof createFakeSessionRuntime>;
  keys: ReturnType<typeof createFakeSessionKeys>;
  clock: { ms: number };
  sessions: ReturnType<typeof createGrillSessionsModule>;
  /** Builds another module over the same store and runtime, as after a restart. */
  restart(): ReturnType<typeof createGrillSessionsModule>;
  start(): Promise<{ id: string; token: string }>;
}

function setup(): Setup {
  const store = createInMemoryGrillSessionStore();
  const runtime = createFakeSessionRuntime();
  const keys = createFakeSessionKeys();
  const clock = { ms: Date.UTC(2026, 0, 1, 12) };
  let sequence = 0;

  const build = (): ReturnType<typeof createGrillSessionsModule> =>
    createGrillSessionsModule({
      runtime,
      store,
      plans: createPlansModule({
        store: createInMemoryPlanStore(),
        ids: () => `plan-${++sequence}`,
        clock: () => new Date(clock.ms),
      }),
      issues: createIssuesModule({
        store: createInMemoryIssueStore(),
        ids: () => `issue-${++sequence}`,
        clock: () => new Date(clock.ms),
      }),
      defaultModel: 'openrouter/default-model',
      keys,
      ids: () => `session-${++sequence}`,
      tokens: () => `report-token-${++sequence}`,
      clock: () => new Date(clock.ms),
      logger: { info: () => {}, error: () => {} },
    });

  const sessions = build();

  return {
    store,
    runtime,
    keys,
    clock,
    sessions,
    restart: build,
    async start() {
      const started = await sessions.start(INPUT);
      if (!started.ok) throw new Error(started.error.message);
      const token = runtime.requests.at(-1)?.reportToken ?? '';
      return { id: started.value.id, token };
    },
  };
}

describe('reaping idle sessions', () => {
  it('stops the runtime and ends the session after 30 minutes without activity', async () => {
    const { sessions, runtime, keys, clock, start } = setup();
    const { id, token } = await start();

    clock.ms += DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const swept = await sessions.sweep();

    expect(swept.ok).toBe(true);
    if (swept.ok) expect(swept.value.ended).toEqual([id]);
    expect(runtime.stopped.map((ref) => ref.sessionId)).toEqual([id]);
    const ended = await sessions.get('p1', id);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect(ended.value.status).toBe('failed');
    expect(ended.value.endReason).toBe('timeout');
    expect(ended.value.endedAt).toBe(new Date(clock.ms).toISOString());
    expect(ended.value.error).toContain('30 minutes without terminal activity');
    // The key and the report token are revoked with the session.
    expect(keys.revoked).toEqual(['hash-session-1']);
    const late = await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.kind).toBe('unauthorized');
  });

  it('keeps a session alive while terminal activity continues', async () => {
    const { sessions, clock, start } = setup();
    const { id } = await start();

    for (let index = 0; index < 3; index += 1) {
      clock.ms += DEFAULT_SESSION_IDLE_TIMEOUT_MS - 60_000;
      await sessions.touch(id);
    }
    const kept = await sessions.sweep();

    expect(kept.ok && kept.value.ended).toEqual([]);
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.status).toBe('active');

    clock.ms += DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const ended = await sessions.sweep();
    expect(ended.ok && ended.value.ended).toEqual([id]);
  });

  it('stops a session at four hours even when it is active', async () => {
    const { sessions, clock, start } = setup();
    const { id } = await start();

    clock.ms += DEFAULT_SESSION_MAX_MS - 1_000;
    await sessions.touch(id);
    clock.ms += 1_000;
    const swept = await sessions.sweep();

    expect(swept.ok && swept.value.ended).toEqual([id]);
    const ended = await sessions.get('p1', id);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect(ended.value.status).toBe('failed');
    expect(ended.value.endReason).toBe('timeout');
    expect(ended.value.error).toContain('4-hour limit');
  });

  it('does not end an already finished session again', async () => {
    const { sessions, runtime, keys, clock, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.', issues: ISSUES });
    const finished = await sessions.finish('p1', id);
    expect(finished.ok).toBe(true);
    runtime.stopped.length = 0;

    clock.ms += DEFAULT_SESSION_MAX_MS * 2;
    const swept = await sessions.sweep();

    expect(swept.ok && swept.value.ended).toEqual([]);
    expect(runtime.stopped).toEqual([]);
    expect(keys.revoked).toEqual(['hash-session-1']);
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.status).toBe('finished');
  });
});

describe('restart reconciliation', () => {
  it('re-adopts a live runtime and keeps its drafts and token', async () => {
    const { restart, runtime, store, start } = setup();
    const { id, token } = await start();
    const restarted = restart();

    const reconciled = await restarted.reconcile();

    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value).toEqual({ adopted: [id], failed: [], stopped: [] });
    expect(runtime.stopped).toEqual([]);
    const active = await restarted.getActive('p1');
    expect(active.ok && active.value?.id).toBe(id);
    const reported = await restarted.report(id, token, { prd: PRD, summary: 'A plan.' });
    expect(reported.ok).toBe(true);
    const persisted = store.get(id);
    expect(persisted?.status).toBe('active');
    expect(persisted?.draft.prd).toBe(PRD);
  });

  it('fails a live session whose runtime is missing, with the reason', async () => {
    const { restart, runtime, keys, start } = setup();
    const { id, token } = await start();
    runtime.forget(id);
    const restarted = restart();

    const reconciled = await restarted.reconcile();

    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.failed).toEqual([id]);
    const ended = await restarted.get('p1', id);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect(ended.value.status).toBe('failed');
    expect(ended.value.endReason).toBe('failed');
    expect(ended.value.error).toContain('runtime is missing');
    expect(keys.revoked).toEqual(['hash-session-1']);
    const late = await restarted.report(id, token, { prd: PRD, summary: 'A plan.' });
    expect(late.ok).toBe(false);
  });

  it('fails a live session whose runtime reports a failure reason', async () => {
    const { restart, runtime, start } = setup();
    const { id } = await start();
    runtime.markFailed(id, 'ErrImagePull: manifest unknown');
    const restarted = restart();

    const reconciled = await restarted.reconcile();

    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.failed).toEqual([id]);
    const ended = await restarted.get('p1', id);
    expect(ended.ok && ended.value.error).toContain('ErrImagePull');
  });

  it('stops a runtime that no live session owns', async () => {
    const { restart, runtime, start } = setup();
    await start();
    runtime.addOrphan({
      sessionId: 'orphan-1',
      projectId: 'p1',
      provider: 'fake',
      handle: 'handle-orphan-1',
      terminal: { url: 'ws://127.0.0.1:4100/ws?session=orphan-1' },
    });
    const restarted = restart();

    const reconciled = await restarted.reconcile();

    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.stopped).toEqual(['orphan-1']);
    expect(runtime.stopped.map((ref) => ref.sessionId)).toEqual(['orphan-1']);
  });

  it('fails a starting session whose runtime was never created', async () => {
    const { restart, store, keys } = setup();
    const record: GrillSessionRecord = {
      id: 'session-crashed',
      projectId: 'p2',
      projectName: 'crashed',
      status: 'starting',
      skillLevel: 'expert',
      model: 'openrouter/default-model',
      startedAt: new Date(Date.UTC(2026, 0, 1, 12)).toISOString(),
      lastActivityAt: new Date(Date.UTC(2026, 0, 1, 12)).toISOString(),
      endedAt: null,
      endReason: null,
      error: null,
      runtime: null,
      reportTokenHash: 'hash',
      openRouterKeyHash: 'hash-session-crashed',
      draft: { prd: null, summary: null, issues: null },
      publishedPlan: null,
      publishedIssues: [],
    };
    store.save(record);
    const restarted = restart();

    const reconciled = await restarted.reconcile();

    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.failed).toEqual(['session-crashed']);
    const ended = await restarted.get('p2', 'session-crashed');
    expect(ended.ok && ended.value.error).toContain('runtime was never created');
    expect(keys.revoked).toEqual(['hash-session-crashed']);
  });

  it('revokes leftover credentials of a session that already ended', async () => {
    const { restart, store, keys } = setup();
    const ended: GrillSessionRecord = {
      id: 'session-ended',
      projectId: 'p3',
      projectName: 'ended',
      status: 'cancelled',
      skillLevel: 'expert',
      model: 'openrouter/default-model',
      startedAt: new Date(Date.UTC(2026, 0, 1, 11)).toISOString(),
      lastActivityAt: new Date(Date.UTC(2026, 0, 1, 11)).toISOString(),
      endedAt: new Date(Date.UTC(2026, 0, 1, 11, 5)).toISOString(),
      endReason: 'cancelled',
      error: null,
      runtime: null,
      // A crash during cleanup left both credential hashes behind.
      reportTokenHash: 'leftover-token-hash',
      openRouterKeyHash: 'hash-session-ended',
      draft: { prd: null, summary: null, issues: null },
      publishedPlan: null,
      publishedIssues: [],
    };
    store.save(ended);
    const restarted = restart();

    await restarted.reconcile();

    expect(keys.revoked).toEqual(['hash-session-ended']);
    expect(store.get('session-ended')?.reportTokenHash).toBeNull();
  });
});
