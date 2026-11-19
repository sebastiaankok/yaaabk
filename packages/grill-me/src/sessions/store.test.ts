import { describe, expect, it } from 'vitest';
import type { GrillSessionRecord } from './session';
import { createInMemoryGrillSessionStore } from './store';

function record(overrides: Partial<GrillSessionRecord> = {}): GrillSessionRecord {
  return {
    id: 'session-1',
    projectId: 'p1',
    projectName: 'todo-app',
    status: 'active',
    skillLevel: 'expert',
    model: 'openrouter/default-model',
    startedAt: '2026-01-01T12:00:00.000Z',
    lastActivityAt: '2026-01-01T12:00:00.000Z',
    endedAt: null,
    endReason: null,
    error: null,
    runtime: null,
    reportTokenHash: 'token-hash',
    openRouterKeyHash: 'key-hash',
    draft: { prd: null, summary: null, issues: null },
    publishedPlan: null,
    publishedIssues: [],
    ...overrides,
  };
}

describe('in-memory grill session store', () => {
  it('saves, reads and lists sessions, including ended ones', () => {
    const store = createInMemoryGrillSessionStore();
    const active = record();
    const ended = record({
      id: 'session-2',
      status: 'cancelled',
      endReason: 'cancelled',
      endedAt: '2026-01-01T12:05:00.000Z',
    });

    store.save(active);
    store.save(ended);

    expect(store.get('session-1')).toEqual(active);
    expect(store.list().map((session) => session.id)).toEqual(['session-1', 'session-2']);
  });

  it('replaces the record for the same id', () => {
    const store = createInMemoryGrillSessionStore();
    store.save(record());
    store.save(record({ status: 'finished', endReason: 'finished' }));

    expect(store.get('session-1')?.status).toBe('finished');
    expect(store.list()).toHaveLength(1);
  });

  it('hands out copies so a caller cannot mutate stored state', () => {
    const store = createInMemoryGrillSessionStore();
    store.save(record());

    const read = store.get('session-1');
    if (read === undefined) throw new Error('missing session');
    read.status = 'failed';

    expect(store.get('session-1')?.status).toBe('active');
  });
});
