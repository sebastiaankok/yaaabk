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

async function createProject(context: TestContext): Promise<string> {
  const created = await context.projects.create(PROJECT);
  if (!created.ok) throw new Error('create failed');
  return created.value.id;
}

async function savePlan(
  context: TestContext,
  session: string,
  projectId: string,
  contentMarkdown = '# Plan',
): Promise<string> {
  const res = await request(context, session, `/api/projects/${projectId}/plans`, {
    method: 'POST',
    body: JSON.stringify({ content_markdown: contentMarkdown, skill_level: 'expert' }),
  });
  expect(res.status).toBe(201);
  const plan = (await res.json()) as { id: string };
  return plan.id;
}

describe('POST /api/projects/:id/plans', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/projects/missing/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content_markdown: '# Plan' }),
    });

    expect(res.status).toBe(401);
  });

  it('creates a plan and marks it active', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({
        content_markdown: '# Plan',
        skill_level: 'expert',
        source: 'grill-me',
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      projectId,
      version: 1,
      contentMarkdown: '# Plan',
      skillLevel: 'expert',
      source: 'grill-me',
      isActive: true,
    });
    await expect(context.plans.list(projectId)).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ version: 1 })],
    });
  });

  it('defaults the skill level to the project', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ content_markdown: '# Plan' }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ skillLevel: 'expert' });
  });

  it('returns 404 for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing/plans', {
      method: 'POST',
      body: JSON.stringify({ content_markdown: '# Plan' }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not-found' });
  });

  it('rejects empty content with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ content_markdown: '   ' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });
});

describe('GET /api/projects/:id/plans', () => {
  it('lists the versions newest first', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await savePlan(context, session, projectId, '# Plan v1');
    await savePlan(context, session, projectId, '# Plan v2');

    const res = await request(context, session, `/api/projects/${projectId}/plans`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      plans: [
        expect.objectContaining({ version: 2, contentMarkdown: '# Plan v2' }),
        expect.objectContaining({ version: 1, contentMarkdown: '# Plan v1' }),
      ],
    });
  });
});

describe('GET /api/projects/:id/plans/active', () => {
  it('returns the active plan', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await savePlan(context, session, projectId, '# Plan v1');
    await savePlan(context, session, projectId, '# Plan v2');

    const res = await request(context, session, `/api/projects/${projectId}/plans/active`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ version: 2, contentMarkdown: '# Plan v2' });
  });

  it('returns 404 when the project has no active plan', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans/active`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not-found' });
  });
});

describe('POST /api/projects/:id/plans/:planId/activate', () => {
  it('activates an earlier version', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const first = await savePlan(context, session, projectId, '# Plan v1');
    await savePlan(context, session, projectId, '# Plan v2');

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/plans/${first}/activate`,
      {
        method: 'POST',
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: first, version: 1, isActive: true });
    await expect(context.plans.getActive(projectId)).resolves.toMatchObject({
      ok: true,
      value: { id: first, version: 1 },
    });
  });

  it('returns 404 for an unknown plan', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/plans/missing/activate`,
      { method: 'POST' },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not-found' });
  });
});
