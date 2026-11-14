import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' } as const;

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

async function signedIn(): Promise<{ context: TestContext; session: string; projectId: string }> {
  const context = createTestContext();
  const session = await signIn(context);
  const created = await context.projects.create(PROJECT);
  if (!created.ok) throw new Error('create project failed');
  return { context, session, projectId: created.value.id };
}

async function addIssue(
  context: TestContext,
  session: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request(context, session, `/api/projects/${projectId}/issues`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
}

describe('issue sync routes', () => {
  it('requires a session', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/projects/missing/issues/sync/status');

    expect(res.status).toBe(401);
  });

  it('reports sync status for a project', async () => {
    const { context, session, projectId } = await signedIn();
    await addIssue(context, session, projectId, { title: 'Add login' });

    const res = await request(context, session, `/api/projects/${projectId}/issues/sync/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 1, synced: 0, pending: 1, lastSyncedAt: null });
  });

  it('pushes approved issues to GitHub', async () => {
    const { context, session, projectId } = await signedIn();
    await addIssue(context, session, projectId, { title: 'Add login', body: 'Form.' });

    const res = await request(context, session, `/api/projects/${projectId}/issues/sync/push`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; status: { synced: number } };
    expect(body.created).toBe(1);
    expect(body.status.synced).toBe(1);
    expect(context.github.issues('acme/todo-app')).toHaveLength(1);
  });

  it('runs a full push-then-pull cycle', async () => {
    const { context, session, projectId } = await signedIn();
    await addIssue(context, session, projectId, { title: 'Add login' });

    const res = await request(context, session, `/api/projects/${projectId}/issues/sync`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { push: { created: number }; pull: { changed: number } };
    expect(body.push.created).toBe(1);
    expect(body.pull.changed).toBe(0);
  });

  it('surfaces a GitHub failure as a bad gateway', async () => {
    const { context, session, projectId } = await signedIn();
    await addIssue(context, session, projectId, { title: 'Add login' });
    context.github.failNext('create-issue', {
      kind: 'unauthorized',
      operation: 'create-issue',
      message: 'Bad credentials',
    });

    const res = await request(context, session, `/api/projects/${projectId}/issues/sync/push`, {
      method: 'POST',
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'github' });
  });

  it('404s for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing/issues/sync/status');

    expect(res.status).toBe(404);
  });
});
