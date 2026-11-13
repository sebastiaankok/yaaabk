import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSpawner } from './fake-spawner';
import { createGrillMeModule } from './session';
import { createSseStream, sseFrame, sseHeartbeat } from './sse';
import type { GrillMeModule } from './types';

const silent = { info: () => {}, error: () => {} };
const decoder = new TextDecoder();

function setup() {
  const spawner = createFakeSpawner();
  const module = createGrillMeModule({
    spawner,
    skillPath: '/skills/grill-me/SKILL.md',
    logger: silent,
  });
  return { module, spawner };
}

async function start(module: GrillMeModule): Promise<string> {
  const result = await module.startSession('proj-1', 'An idea', 'expert');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sseFrame', () => {
  it('encodes an event name and JSON payload', () => {
    expect(sseFrame('question', { sessionId: 's1', question: 'Why?' })).toBe(
      'event: question\ndata: {"sessionId":"s1","question":"Why?"}\n\n',
    );
  });

  it('encodes an event id when supplied', () => {
    expect(sseFrame('question', { sessionId: 's1', question: 'Why?' }, 7)).toBe(
      'id: 7\nevent: question\ndata: {"sessionId":"s1","question":"Why?"}\n\n',
    );
  });

  it('encodes a heartbeat as a comment frame', () => {
    expect(sseHeartbeat()).toBe(': keep-alive\n\n');
  });
});

describe('createSseStream', () => {
  it('streams only the events of the requested session', async () => {
    const { module, spawner } = setup();
    const first = await start(module);
    const second = await start(module);
    const reader = createSseStream(module, first, { heartbeatMs: 0 }).getReader();

    spawner.processes[1]?.emit('<QUESTION>Other session?</QUESTION>');
    spawner.processes[0]?.emit('<QUESTION>Which database?</QUESTION>');

    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe(
      `id: 1\nevent: question\ndata: ${JSON.stringify({ sessionId: first, question: 'Which database?' })}\n\n`,
    );
    expect(second).not.toBe(first);
    await reader.cancel();
  });

  it('closes the stream when the session ends', async () => {
    const { module } = setup();
    const sessionId = await start(module);
    const reader = createSseStream(module, sessionId, { heartbeatMs: 0 }).getReader();

    await module.cancelSession(sessionId);

    const ended = await reader.read();
    expect(decoder.decode(ended.value)).toBe(
      `id: 1\nevent: ended\ndata: ${JSON.stringify({ sessionId, reason: 'cancelled' })}\n\n`,
    );
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('emits heartbeat comments while the session is open', async () => {
    vi.useFakeTimers();
    const { module } = setup();
    const sessionId = await start(module);
    const reader = createSseStream(module, sessionId, { heartbeatMs: 1000 }).getReader();

    await vi.advanceTimersByTimeAsync(1000);

    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe(': keep-alive\n\n');
    await reader.cancel();
  });
});
