import { createInMemoryIssueStore, createIssuesModule } from '@yaaabk/issues';
import { createInMemoryPlanStore, createPlansModule } from '@yaaabk/plans';
import { describe, expect, it } from 'vitest';
import { createFakeSessionRuntime } from './fake-runtime';
import { createGrillSessionsModule, type StartGrillSessionInput } from './session';

function setup(options: { defaultModel?: string } = {}) {
  const runtime = createFakeSessionRuntime();
  const clock = { ms: Date.UTC(2026, 0, 1, 12) };
  let sequence = 0;
  const sessions = createGrillSessionsModule({
    runtime,
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
    defaultModel: options.defaultModel ?? 'openrouter/default-model',
    clock: () => new Date(clock.ms),
    ids: () => `session-${++sequence}`,
    logger: { info: () => {}, error: () => {} },
  });
  return { runtime, sessions, clock };
}

const INPUT: StartGrillSessionInput = {
  projectId: 'p1',
  projectName: 'todo-app',
  idea: 'A todo app',
  skillLevel: 'expert',
};

describe('starting a grill session', () => {
  it('uses the configured default model when the request supplies none', async () => {
    const { runtime, sessions } = setup({ defaultModel: 'openrouter/default-model' });

    const started = await sessions.start(INPUT);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.model).toBe('openrouter/default-model');
    expect(runtime.requests[0]?.model).toBe('openrouter/default-model');
  });

  it('uses the requested model when one is supplied', async () => {
    const { runtime, sessions } = setup();

    const started = await sessions.start({ ...INPUT, model: 'openrouter/chosen-model' });

    expect(started.ok).toBe(true);
    if (started.ok) expect(started.value.model).toBe('openrouter/chosen-model');
    expect(runtime.requests[0]?.model).toBe('openrouter/chosen-model');
  });

  it('carries the idea, skill level and active plan into the opening prompt', async () => {
    const { runtime, sessions } = setup();

    await sessions.start({
      ...INPUT,
      idea: 'A recipe box',
      skillLevel: 'beginner',
      activePlan: '# Existing plan',
    });

    const prompt = runtime.requests[0]?.prompt ?? '';
    expect(prompt).toContain('A recipe box');
    expect(prompt).toContain('beginner');
    expect(prompt).toContain('# Existing plan');
  });

  it('replaces the previous active session for the same Project', async () => {
    const { runtime, sessions } = setup();

    const first = await sessions.start(INPUT);
    const second = await sessions.start({ ...INPUT, idea: 'Second idea' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runtime.stopped).toHaveLength(1);
    expect(runtime.stopped[0]?.sessionId).toBe(first.ok ? first.value.id : '');
    const active = await sessions.getActive('p1');
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.value?.id).toBe(second.ok ? second.value.id : '');
    const previous = await sessions.get('p1', first.ok ? first.value.id : '');
    expect(previous.ok).toBe(true);
    if (previous.ok) {
      expect(previous.value.status).toBe('cancelled');
      expect(previous.value.endReason).toBe('replaced');
    }
  });

  it('returns a specific failure and leaves no active session', async () => {
    const { runtime, sessions } = setup();
    runtime.failNextStart('ttyd: exec format error');

    const started = await sessions.start(INPUT);

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.kind).toBe('start-failed');
      expect(started.error.message).toContain('exec format error');
    }
    const active = await sessions.getActive('p1');
    expect(active.ok && active.value).toBeNull();
  });

  it('rejects an empty idea', async () => {
    const { sessions } = setup();

    const started = await sessions.start({ ...INPUT, idea: '   ' });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.kind).toBe('invalid-input');
  });
});

describe('cancelling a grill session', () => {
  it('stops the runtime and clears the active session', async () => {
    const { runtime, sessions } = setup();
    const started = await sessions.start(INPUT);
    if (!started.ok) throw new Error('start failed');

    const cancelled = await sessions.cancel('p1', started.value.id);

    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.status).toBe('cancelled');
      expect(cancelled.value.endReason).toBe('cancelled');
    }
    expect(runtime.stopped[0]?.sessionId).toBe(started.value.id);
    const active = await sessions.getActive('p1');
    expect(active.ok && active.value).toBeNull();
  });

  it('rejects a session that belongs to another Project', async () => {
    const { sessions } = setup();
    const started = await sessions.start(INPUT);
    if (!started.ok) throw new Error('start failed');

    const cancelled = await sessions.cancel('other-project', started.value.id);

    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error.kind).toBe('not-found');
  });
});

describe('session activity and terminal access', () => {
  it('returns the runtime terminal endpoint without exposing it in the session view', async () => {
    const { sessions } = setup();
    const started = await sessions.start(INPUT);
    if (!started.ok) throw new Error('start failed');

    const terminal = await sessions.terminal(started.value.id);

    expect(terminal.ok).toBe(true);
    if (terminal.ok) expect(terminal.value.url).toMatch(/^ws:\/\//);
    expect(JSON.stringify(started.value)).not.toContain('credential');
    expect(JSON.stringify(started.value)).not.toContain('test-token');
  });

  it('records terminal activity', async () => {
    const { sessions, clock } = setup();
    const started = await sessions.start(INPUT);
    if (!started.ok) throw new Error('start failed');
    clock.ms += 5_000;

    const touched = await sessions.touch(started.value.id);

    expect(touched.ok).toBe(true);
    const current = await sessions.get('p1', started.value.id);
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.value.lastActivityAt).toBe(new Date(clock.ms).toISOString());
    }
  });

  it('rejects a terminal request after the session is cancelled', async () => {
    const { sessions } = setup();
    const started = await sessions.start(INPUT);
    if (!started.ok) throw new Error('start failed');
    await sessions.cancel('p1', started.value.id);

    const terminal = await sessions.terminal(started.value.id);

    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.kind).toBe('not-found');
  });
});
