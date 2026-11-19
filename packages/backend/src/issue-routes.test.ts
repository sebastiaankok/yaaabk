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

  it('accepts a catalogue agent model, or rejects an unknown one', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const accepted = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add login', agentModel: 'openrouter/chosen' }),
    });
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({ agentModel: 'openrouter/chosen' });

    const rejected = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add signup', agentModel: 'openrouter/not-a-model' }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: 'invalid-model' });
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

  it('sets and clears the agent model override', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const set = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ agentModel: 'openrouter/chosen' }),
    });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({ agentModel: 'openrouter/chosen' });

    context.models.fail('OpenRouter is down');
    const cleared = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ agentModel: null }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ agentModel: null });
  });

  it('rejects a model outside the tool-capable catalogue with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ agentModel: 'openrouter/not-a-model' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-model' });
  });

  it('returns 502 when the model catalogue cannot be loaded', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);
    context.models.fail('OpenRouter is down');

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ agentModel: 'openrouter/chosen' }),
    });

    expect(res.status).toBe(502);
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

  it('approves only the active plan\u2019s open issues', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const first = await context.plans.create({
      projectId,
      contentMarkdown: '# Old',
      skillLevel: 'expert',
      source: 'grill-me',
    });
    const second = await context.plans.create({
      projectId,
      contentMarkdown: '# New',
      skillLevel: 'expert',
      source: 'grill-me',
    });
    if (!first.ok || !second.ok) throw new Error('plan setup failed');

    const old = await createIssue(context, session, projectId, {
      title: 'Old work',
      planId: first.value.id,
      label: 'refinement-needed',
    });
    await createIssue(context, session, projectId, {
      title: 'New work',
      planId: second.value.id,
      label: 'refinement-needed',
    });
    const done = await createIssue(context, session, projectId, {
      title: 'Finished',
      planId: second.value.id,
      label: 'refinement-needed',
    });
    const closed = await request(context, session, `/api/projects/${projectId}/issues/${done.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(closed.status).toBe(200);

    const res = await request(context, session, `/api/projects/${projectId}/issues/approve`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: Array<{ id: string; title: string }> };
    expect(body.issues.map((issue) => issue.title)).toEqual(['New work']);

    const oldIssue = await context.issues.get(projectId, old.id);
    expect(oldIssue.ok && oldIssue.value.label).toBe('refinement-needed');
  });
});
