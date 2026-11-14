import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' } as const;

/** Awaits pending microtasks (e.g. the grill-me spawn). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits until the in-flight request has spawned its grill-me process. */
async function waitForSpawn(context: TestContext): Promise<void> {
  for (let i = 0; i < 100 && context.spawner.processes.length === 0; i += 1) {
    await tick();
  }
  if (context.spawner.processes.length === 0) {
    throw new Error('The grill-me process was never spawned');
  }
}

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

async function savePlan(context: TestContext, session: string, projectId: string): Promise<void> {
  const res = await request(context, session, `/api/projects/${projectId}/plans`, {
    method: 'POST',
    body: JSON.stringify({ content_markdown: '# Plan', skill_level: 'expert' }),
  });
  expect(res.status).toBe(201);
}

async function createIssue(
  context: TestContext,
  session: string,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await request(context, session, `/api/projects/${projectId}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Add login', ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe('POST /api/projects/:id/issues', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/projects/missing/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Add login' }),
    });

    expect(res.status).toBe(401);
  });

  it('creates an issue', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Add login',
        body: 'With OAuth',
        label: 'ready',
        depends_on: ['Schema'],
        budget_cents: 80,
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      projectId,
      title: 'Add login',
      body: 'With OAuth',
      label: 'ready',
      dependsOn: ['Schema'],
      budgetCents: 80,
      status: 'open',
    });
  });

  it('rejects a blank title with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: '   ' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });

  it('returns 409 for a duplicate title', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add login' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'duplicate-title' });
  });

  it('returns 404 for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing/issues', {
      method: 'POST',
      body: JSON.stringify({ title: 'Add login' }),
    });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:id/issues', () => {
  it('lists the issues oldest first', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await createIssue(context, session, projectId, { title: 'First' });
    await createIssue(context, session, projectId, { title: 'Second' });

    const res = await request(context, session, `/api/projects/${projectId}/issues`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      issues: [
        expect.objectContaining({ title: 'First' }),
        expect.objectContaining({ title: 'Second' }),
      ],
    });
  });
});

describe('GET /api/projects/:id/issues/graph', () => {
  it('returns waves and resolved dependencies', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await createIssue(context, session, projectId, { title: 'Schema' });
    await createIssue(context, session, projectId, { title: 'Api', depends_on: ['Schema'] });

    const res = await request(context, session, `/api/projects/${projectId}/issues/graph`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      nodes: [
        expect.objectContaining({ title: 'Schema', wave: 0 }),
        expect.objectContaining({ title: 'Api', wave: 1 }),
      ],
      cycles: [],
    });
  });
});

describe('GET /api/projects/:id/issues/:issueId', () => {
  it('returns the issue', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id, title: 'Add login' });
  });

  it('returns 404 for an unknown issue', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/issues/missing`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/projects/:id/issues/:issueId', () => {
  it('updates the provided fields', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'blocked', status: 'in_progress' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id,
      label: 'blocked',
      status: 'in_progress',
      title: 'Add login',
    });
  });

  it('rejects an unknown label with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'urgent' }),
    });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/projects/:id/issues/:issueId', () => {
  it('removes the issue', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe('POST /api/projects/:id/issues/approve', () => {
  it('marks every issue ready', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await createIssue(context, session, projectId, { title: 'First', label: 'refinement-needed' });

    const res = await request(context, session, `/api/projects/${projectId}/issues/approve`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      issues: [expect.objectContaining({ label: 'ready' })],
    });
  });
});

describe('POST /api/projects/:id/issues/generate', () => {
  const ISSUES =
    '<ISSUES>[{"title":"Add auth","body":"","labels":["ready"],"depends_on":[]}]</ISSUES>';

  it('returns 404 when the project has no active plan', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/issues/generate`, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
  });

  it('generates issues from the active plan and records them', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await savePlan(context, session, projectId);

    const pending = request(context, session, `/api/projects/${projectId}/issues/generate`, {
      method: 'POST',
    });
    await waitForSpawn(context);
    context.spawner.last().emit(ISSUES);
    const res = await pending;

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      issues: [expect.objectContaining({ title: 'Add auth', label: 'ready' })],
    });
    await expect(context.issues.list(projectId)).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ title: 'Add auth' })],
    });
  });

  it('maps a failed run to 422', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await savePlan(context, session, projectId);

    const pending = request(context, session, `/api/projects/${projectId}/issues/generate`, {
      method: 'POST',
    });
    await waitForSpawn(context);
    context.spawner.last().exit(0);
    const res = await pending;

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-issues' });
  });
});

describe('POST /api/projects/:id/issues/refine', () => {
  const REVISED = '<ISSUES>[{"title":"Add OAuth","labels":["ready"],"depends_on":[]}]</ISSUES>';

  it('rejects empty feedback with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/issues/refine`, {
      method: 'POST',
      body: JSON.stringify({ feedback: '   ' }),
    });

    expect(res.status).toBe(400);
  });

  it('replaces the drafts using the feedback', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await savePlan(context, session, projectId);

    const pending = request(context, session, `/api/projects/${projectId}/issues/refine`, {
      method: 'POST',
      body: JSON.stringify({ feedback: 'Split the auth issue' }),
    });
    await waitForSpawn(context);
    expect(context.spawner.requests[0]?.prompt).toContain('Split the auth issue');
    context.spawner.last().emit(REVISED);
    const res = await pending;

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      issues: [expect.objectContaining({ title: 'Add OAuth' })],
    });
  });
});
