import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' } as const;
const decoder = new TextDecoder();

async function request(
  context: TestContext,
  session: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return context.app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${session}`,
      ...init.headers,
    },
  });
}

async function signedIn(): Promise<{ context: TestContext; session: string }> {
  const context = createTestContext();
  const session = await signIn(context);
  return { context, session };
}

async function createProject(context: TestContext, name = 'todo-app'): Promise<string> {
  const created = await context.projects.create({ ...PROJECT, name });
  if (!created.ok) throw new Error('create failed');
  return created.value.id;
}

async function startSession(
  context: TestContext,
  session: string,
  projectId: string,
  idea = 'A todo app',
): Promise<string> {
  const res = await request(context, session, `/api/projects/${projectId}/grill`, {
    method: 'POST',
    body: JSON.stringify({ idea }),
  });
  expect(res.status).toBe(201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return sessionId;
}

/** Awaits pending microtasks so a fire-and-forget plan save can complete. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('POST /api/projects/:id/grill', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/projects/missing/grill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'A todo app' }),
    });

    expect(res.status).toBe(401);
  });

  it('starts a session for the project and returns its id', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const sessionId = await startSession(context, session, projectId, 'A todo app');

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.spawner.requests[0]).toMatchObject({
      sessionId,
      projectId,
      idea: 'A todo app',
      skillLevel: 'expert',
    });
  });

  it('returns 404 for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing/grill', {
      method: 'POST',
      body: JSON.stringify({ idea: 'A todo app' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects an empty idea with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/grill`, {
      method: 'POST',
      body: JSON.stringify({ idea: '   ' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });

  it('cancels the previous session when starting a new one', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    await startSession(context, session, projectId, 'First');
    await startSession(context, session, projectId, 'Second');

    expect(context.spawner.processes[0]?.stopped).toBe(true);
    expect(context.spawner.processes[1]?.stopped).toBe(false);
  });
});

describe('GET /api/projects/:id/grill', () => {
  it('streams the session events as SSE', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const sessionId = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill?sessionId=${sessionId}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    context.spawner.processes[0]?.emit('<QUESTION>Which database?</QUESTION>');

    const { value } = await reader.read();
    expect(decoder.decode(value)).toContain('event: question');
    expect(decoder.decode(value)).toContain('Which database?');
    await reader.cancel();
  });

  it('rejects a request without a sessionId', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/grill`);

    expect(res.status).toBe(400);
  });

  it('rejects a session id that belongs to another project', async () => {
    const { context, session } = await signedIn();
    const first = await createProject(context, 'todo-app');
    const second = await createProject(context, 'other-app');
    const sessionId = await startSession(context, session, first);

    const res = await request(
      context,
      session,
      `/api/projects/${second}/grill?sessionId=${sessionId}`,
    );

    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:id/grill/:sessionId/answer', () => {
  it('sends the answer to the process', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const sessionId = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${sessionId}/answer`,
      { method: 'POST', body: JSON.stringify({ answer: 'Postgres' }) },
    );

    expect(res.status).toBe(200);
    expect(context.spawner.processes[0]?.sent).toEqual(['Postgres']);
  });

  it('rejects an empty answer with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const sessionId = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${sessionId}/answer`,
      { method: 'POST', body: JSON.stringify({ answer: '   ' }) },
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/grill/missing/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Postgres' }),
    });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:id/grill/:sessionId/refine', () => {
  it('sends the refinement feedback to the process', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const sessionId = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${sessionId}/refine`,
      { method: 'POST', body: JSON.stringify({ feedback: 'Split the first issue' }) },
    );

    expect(res.status).toBe(200);
    expect(context.spawner.processes[0]?.sent[0]).toContain('Split the first issue');
  });
});

describe('POST /api/projects/:id/grill/:sessionId/cancel', () => {
  it('stops the process', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const sessionId = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${sessionId}/cancel`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    expect(context.spawner.processes[0]?.stopped).toBe(true);
  });
});

describe('plans from a grill-me session', () => {
  it('saves the plan when the skill emits a <PLAN> marker', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await startSession(context, session, projectId);

    context.spawner.processes[0]?.emit('<PLAN># Refined plan</PLAN>');
    await tick();

    await expect(context.plans.list(projectId)).resolves.toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          version: 1,
          contentMarkdown: '# Refined plan',
          source: 'grill-me',
          skillLevel: 'expert',
          isActive: true,
        }),
      ],
    });
  });
});

describe('issues from a grill-me session', () => {
  const ISSUES = (title: string) =>
    `<ISSUES>[{"title":"${title}","labels":["ready"],"depends_on":[]}]</ISSUES>`;

  it('records the generated issues against the active plan', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await startSession(context, session, projectId);

    context.spawner.processes[0]?.emit('<PLAN># Refined plan</PLAN>');
    context.spawner.processes[0]?.emit(ISSUES('Add auth'));
    await tick();

    await expect(context.issues.list(projectId)).resolves.toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          title: 'Add auth',
          label: 'ready',
          planId: expect.any(String),
        }),
      ],
    });
  });

  it('replaces the previous drafts when the skill emits a new list', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await startSession(context, session, projectId);

    context.spawner.processes[0]?.emit('<PLAN># Refined plan</PLAN>');
    context.spawner.processes[0]?.emit(ISSUES('First pass'));
    await tick();
    context.spawner.processes[0]?.emit(ISSUES('Second pass'));
    await tick();

    const listed = await context.issues.list(projectId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((issue) => issue.title)).toEqual(['Second pass']);
  });
});
