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

async function signedIn(): Promise<{ context: TestContext; session: string }> {
  const context = createTestContext();
  const session = await signIn(context);
  return { context, session };
}

describe('POST /api/projects', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PROJECT),
    });

    expect(res.status).toBe(401);
  });

  it('creates a project and returns it', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects', {
      method: 'POST',
      body: JSON.stringify(PROJECT),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      name: 'todo-app',
      description: 'A todo list',
      skillLevel: 'expert',
    });
    await expect(context.projects.list()).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ name: 'todo-app' })],
    });
  });

  it('rejects an invalid name with 400', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ ...PROJECT, name: 'Not Valid' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });

  it('rejects a duplicate name with 409', async () => {
    const { context, session } = await signedIn();
    await context.projects.create(PROJECT);

    const res = await request(context, session, '/api/projects', {
      method: 'POST',
      body: JSON.stringify(PROJECT),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'duplicate-name' });
  });
});

describe('GET /api/projects', () => {
  it('lists the projects', async () => {
    const { context, session } = await signedIn();
    await context.projects.create(PROJECT);

    const res = await request(context, session, '/api/projects');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      projects: [expect.objectContaining({ name: 'todo-app' })],
    });
  });
});

describe('GET /api/projects/:id', () => {
  it('returns a project by id', async () => {
    const { context, session } = await signedIn();
    const created = await context.projects.create(PROJECT);
    if (!created.ok) throw new Error('create failed');

    const res = await request(context, session, `/api/projects/${created.value.id}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: created.value.id, name: 'todo-app' });
  });

  it('returns 404 for an unknown id', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not-found' });
  });
});

describe('PATCH /api/projects/:id', () => {
  it('updates the project metadata', async () => {
    const { context, session } = await signedIn();
    const created = await context.projects.create(PROJECT);
    if (!created.ok) throw new Error('create failed');

    const res = await request(context, session, `/api/projects/${created.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Updated' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ description: 'Updated' });
  });

  it('returns 404 for an unknown id', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing', {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Updated' }),
    });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('removes the project', async () => {
    const { context, session } = await signedIn();
    const created = await context.projects.create(PROJECT);
    if (!created.ok) throw new Error('create failed');

    const res = await request(context, session, `/api/projects/${created.value.id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    await expect(context.projects.get(created.value.id)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
  });

  it('returns 404 for an unknown id', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing', { method: 'DELETE' });

    expect(res.status).toBe(404);
  });
});
