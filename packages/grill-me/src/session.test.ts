import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSpawner } from './fake-spawner';
import type { OpenCodeProcess, OpenCodeSpawner } from './process';
import { createGrillMeModule, type GrillMeModuleOptions } from './session';
import type { GrillMeEventName, GrillMeModule } from './types';

const SKILL_PATH = '/skills/grill-me/SKILL.md';
const silent = { info: () => {}, error: () => {} };

interface RecordedEvent {
  event: GrillMeEventName;
  payload: Record<string, unknown>;
}

/** Subscribes to every event, recording them in order. */
function record(module: GrillMeModule): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  const on = module.on as unknown as (
    event: GrillMeEventName,
    handler: (payload: Record<string, unknown>) => void,
  ) => () => void;
  const names: GrillMeEventName[] = [
    'token',
    'question',
    'plan_ready',
    'issues_generated',
    'error',
    'ended',
  ];
  for (const name of names) {
    on(name, (payload) => events.push({ event: name, payload }));
  }
  return events;
}

function setup(options: Partial<GrillMeModuleOptions> = {}) {
  const spawner = createFakeSpawner();
  const module = createGrillMeModule({
    spawner,
    skillPath: SKILL_PATH,
    logger: silent,
    ...options,
  });
  const events = record(module);
  return { module, spawner, events };
}

/** Starts a session, failing the test if the module reports an error. */
async function start(module: GrillMeModule, idea = 'An idea'): Promise<string> {
  const result = await module.startSession('proj-1', idea, 'expert');
  if (!result.ok) {
    throw new Error(`startSession failed: ${result.error.message}`);
  }
  return result.value;
}

/** Awaits pending microtasks (e.g. the `exited` promise's `.then`). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('startSession', () => {
  it('spawns a process and resolves the new session id', async () => {
    const { module, spawner } = setup();

    const result = await module.startSession('proj-1', 'A todo app', 'beginner');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawner.requests).toHaveLength(1);
    expect(spawner.requests[0]).toMatchObject({
      sessionId: result.value,
      projectId: 'proj-1',
      idea: 'A todo app',
      skillLevel: 'beginner',
      skillPath: SKILL_PATH,
    });
    expect(spawner.requests[0]?.prompt).toContain('A todo app');
  });

  it('changes the prompt depth with the skill level', async () => {
    const { module, spawner } = setup();

    await module.startSession('proj-1', 'An idea', 'beginner');
    await module.startSession('proj-1', 'An idea', 'expert');

    const [beginner, expert] = spawner.requests;
    expect(beginner?.prompt).not.toBe(expert?.prompt);
    expect(beginner?.prompt).toContain('beginner');
    expect(expert?.prompt).toContain('expert');
  });

  it.each([
    ['an empty idea', 'proj-1', '   ', 'expert'],
    ['an empty project id', '', 'An idea', 'expert'],
    ['an unknown skill level', 'proj-1', 'An idea', 'wizard'],
  ])('rejects %s without spawning', async (_label, projectId, idea, skillLevel) => {
    const { module, spawner } = setup();

    const result = await module.startSession(projectId, idea, skillLevel as 'expert');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
    expect(spawner.requests).toEqual([]);
  });

  it('reports a failed launch as spawn-failed', async () => {
    const spawner = createFakeSpawner({ spawnError: 'opencode not found' });
    const module = createGrillMeModule({ spawner, skillPath: SKILL_PATH, logger: silent });

    const result = await module.startSession('proj-1', 'An idea', 'expert');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'spawn-failed', operation: 'startSession' });
  });
});

describe('output events', () => {
  it('emits token, question, plan and issues events as markers arrive', async () => {
    const { module, spawner, events } = setup();
    const sessionId = await start(module);

    const process = spawner.last();
    process.emit('Thinking… ');
    process.emit('<QUESTION>Which database?</QUESTION>');
    process.emit('<PLAN># Plan\n\n- step one</PLAN>');
    process.emit(
      '<ISSUES>[{"title":"Add auth","labels":["ready"],"depends_on":["Set up DB"]}]</ISSUES>',
    );

    expect(events).toEqual([
      { event: 'token', payload: { sessionId, text: 'Thinking… ' } },
      { event: 'question', payload: { sessionId, question: 'Which database?' } },
      { event: 'plan_ready', payload: { sessionId, plan: '# Plan\n\n- step one' } },
      {
        event: 'issues_generated',
        payload: {
          sessionId,
          issues: [{ title: 'Add auth', body: '', labels: ['ready'], depends_on: ['Set up DB'] }],
        },
      },
    ]);
  });

  it('emits an error event when the issues block is malformed', async () => {
    const { module, spawner, events } = setup();
    const sessionId = await start(module);

    spawner.last().emit('<ISSUES>not json</ISSUES>');

    expect(events).toEqual([
      {
        event: 'error',
        payload: { sessionId, error: expect.objectContaining({ kind: 'invalid-issues' }) },
      },
    ]);
  });
});

describe('commands', () => {
  it('sends the answer to the process', async () => {
    const { module, spawner } = setup();
    const sessionId = await start(module);

    const sent = await module.submitAnswer(sessionId, 'Postgres please');

    expect(sent.ok).toBe(true);
    expect(spawner.last().sent).toEqual(['Postgres please']);
  });

  it('sends refinement feedback wrapped for the agent', async () => {
    const { module, spawner } = setup();
    const sessionId = await start(module);

    await module.refineIssues(sessionId, 'Split the auth issue');

    const [message] = spawner.last().sent;
    expect(message).toContain('Split the auth issue');
    expect(message).toContain('<ISSUES>');
  });

  it('rejects an empty answer', async () => {
    const { module } = setup();
    const sessionId = await start(module);

    const result = await module.submitAnswer(sessionId, '  ');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });

  it('reports an unknown session', async () => {
    const { module } = setup();

    const result = await module.submitAnswer('does-not-exist', 'hello');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unknown-session');
  });

  it('reports a write failure as write-failed', async () => {
    const spawner: OpenCodeSpawner = {
      async spawn(): Promise<OpenCodeProcess> {
        return {
          // Stays alive until stopped, like a real process.
          exited: new Promise(() => {}),
          send: async () => {
            throw new Error('EPIPE');
          },
          stop: async () => {},
        };
      },
    };
    const module = createGrillMeModule({ spawner, skillPath: SKILL_PATH, logger: silent });
    const sessionId = await start(module);

    const result = await module.submitAnswer(sessionId, 'hello');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('write-failed');
  });
});

describe('generateIssues', () => {
  const PLAN = '# Plan\n\n- set up the database';
  const ISSUES =
    '<ISSUES>[{"title":"Add auth","labels":["ready"],"depends_on":["Set up DB"]}]</ISSUES>';

  it('spawns a one-shot run seeded with the plan and resolves the parsed issues', async () => {
    const { module, spawner } = setup();

    const pending = module.generateIssues('proj-1', PLAN, 'expert');
    await tick();
    spawner.last().emit(ISSUES);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { title: 'Add auth', body: '', labels: ['ready'], depends_on: ['Set up DB'] },
    ]);
    expect(spawner.requests[0]).toMatchObject({ projectId: 'proj-1', skillLevel: 'expert' });
    expect(spawner.requests[0]?.prompt).toContain('set up the database');
    expect(spawner.last().stopped).toBe(true);
  });

  it('folds refine feedback into the prompt', async () => {
    const { module, spawner } = setup();

    const pending = module.generateIssues('proj-1', PLAN, 'expert', { feedback: 'Split auth' });
    await tick();
    spawner.last().emit(ISSUES);
    await pending;

    expect(spawner.requests[0]?.prompt).toContain('Split auth');
  });

  it('ignores question and plan blocks while waiting for the issue list', async () => {
    const { module, spawner } = setup();

    const pending = module.generateIssues('proj-1', PLAN, 'expert');
    await tick();
    spawner.last().emit('<QUESTION>Which database?</QUESTION>');
    spawner.last().emit('<PLAN># Plan</PLAN>');
    spawner.last().emit(ISSUES);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('flushes a final issue block when the process exits', async () => {
    const { module, spawner } = setup();

    const pending = module.generateIssues('proj-1', PLAN, 'expert');
    await tick();
    spawner.last().emit(ISSUES);
    spawner.last().exit(0);
    await tick();
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('reports a run that produced no issues as invalid-issues', async () => {
    const { module, spawner } = setup();

    const pending = module.generateIssues('proj-1', PLAN, 'expert');
    await tick();
    spawner.last().exit(0);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-issues');
  });

  it('reports a non-zero exit with no issues as process-failed', async () => {
    const { module, spawner } = setup();

    const pending = module.generateIssues('proj-1', PLAN, 'expert');
    await tick();
    spawner.last().exit(1);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('process-failed');
  });

  it.each([
    ['an empty plan', 'proj-1', '   ', 'expert'],
    ['an empty project id', '', PLAN, 'expert'],
    ['an unknown skill level', 'proj-1', PLAN, 'wizard'],
  ])('rejects %s without spawning', async (_label, projectId, plan, skillLevel) => {
    const { module, spawner } = setup();

    const result = await module.generateIssues(projectId, plan, skillLevel as 'expert');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
    expect(spawner.requests).toEqual([]);
  });

  it('reports a failed launch as spawn-failed', async () => {
    const spawner = createFakeSpawner({ spawnError: 'opencode not found' });
    const module = createGrillMeModule({ spawner, skillPath: SKILL_PATH, logger: silent });

    const result = await module.generateIssues('proj-1', PLAN, 'expert');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'spawn-failed', operation: 'generateIssues' });
  });

  it('times out and stops the process', async () => {
    vi.useFakeTimers();
    const { module, spawner } = setup({ timeoutMs: 1000 });

    const pending = module.generateIssues('proj-1', PLAN, 'expert');
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('timeout');
    expect(spawner.last().stopped).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('cancel stops the process and emits a cancelled end', async () => {
    const { module, spawner, events } = setup();
    const sessionId = await start(module);

    const result = await module.cancelSession(sessionId);

    expect(result.ok).toBe(true);
    expect(spawner.last().stopped).toBe(true);
    expect(events).toEqual([{ event: 'ended', payload: { sessionId, reason: 'cancelled' } }]);
    expect((await module.submitAnswer(sessionId, 'too late')).ok).toBe(false);
  });

  it('ends a session after the timeout and stops the process', async () => {
    vi.useFakeTimers();
    const { module, spawner, events } = setup({ timeoutMs: 1000 });
    const sessionId = await start(module);

    await vi.advanceTimersByTimeAsync(1000);

    expect(spawner.last().stopped).toBe(true);
    expect(events).toContainEqual({ event: 'ended', payload: { sessionId, reason: 'timeout' } });
    expect(events).toContainEqual({
      event: 'error',
      payload: { sessionId, error: expect.objectContaining({ kind: 'timeout' }) },
    });
  });

  it('ends a session when the process exits cleanly', async () => {
    const { module, spawner, events } = setup();
    const sessionId = await start(module);

    spawner.last().exit(0);
    await tick();

    expect(events).toEqual([{ event: 'ended', payload: { sessionId, reason: 'completed' } }]);
  });

  it('reports a non-zero exit as failed', async () => {
    const { module, spawner, events } = setup();
    const sessionId = await start(module);

    spawner.last().exit(1);
    await tick();

    expect(events).toContainEqual({
      event: 'error',
      payload: { sessionId, error: expect.objectContaining({ kind: 'process-failed' }) },
    });
    expect(events).toContainEqual({ event: 'ended', payload: { sessionId, reason: 'failed' } });
  });

  it('does not end a session twice when cancelled while exiting', async () => {
    const { module, spawner, events } = setup();
    const sessionId = await start(module);

    await module.cancelSession(sessionId);
    spawner.last().exit(0);
    await tick();

    expect(events.filter((event) => event.event === 'ended')).toHaveLength(1);
  });

  it('unsubscribes a handler when its disposer is called', async () => {
    const { module, spawner } = setup();
    const seen: string[] = [];
    const off = module.on('question', (payload) => seen.push(payload.question));
    const sessionId = await start(module);
    expect(sessionId).toBeTruthy();

    spawner.last().emit('<QUESTION>First?</QUESTION>');
    off();
    spawner.last().emit('<QUESTION>Second?</QUESTION>');

    expect(seen).toEqual(['First?']);
  });
});
