import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', mode: 'guided' } as const;

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

  it('stores a supplied summary and derives one when absent', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const supplied = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add login', summary: '  Let a   Developer sign in. ' }),
    });
    const derived = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add signup', body: 'Create an account.' }),
    });

    expect(supplied.status).toBe(201);
    await expect(supplied.json()).resolves.toMatchObject({
      summary: 'Let a Developer sign in.',
    });
    expect(derived.status).toBe(201);
    await expect(derived.json()).resolves.toMatchObject({ summary: 'Create an account.' });
  });

  it('rejects an over-long summary with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add login', summary: 'x'.repeat(201) }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
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

describe('GET /api/projects/:id/issues/:issueId/budget', () => {
  it('reports the whole budget as remaining before the first attempt', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId, { budget_cents: 80 });

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}/budget`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      issueId: id,
      budgetCents: 80,
      spentCents: 0,
      remainingCents: 80,
      keyOpen: false,
      exhausted: false,
    });
  });

  it('counts earlier attempts and the open key usage against the budget', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId, { budget_cents: 200 });
    const opened = await context.issueBudgets.open(id, { budgetCents: 200 });
    if (!opened.ok) throw new Error('open failed');
    context.budgetApi.setUsage(opened.value.keyHash, 1.2);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}/budget`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      budgetCents: 200,
      spentCents: 120,
      remainingCents: 80,
      keyOpen: true,
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

  it('updates the summary and rejects an empty or over-long one', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const updated = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ summary: '  Let a   Developer sign in. ' }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      summary: 'Let a Developer sign in.',
    });

    for (const summary of ['   ', 'x'.repeat(201)]) {
      const rejected = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ summary }),
      });
      expect(rejected.status).toBe(400);
    }
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

  it('raises the open key cap when the Issue budget is raised', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId, { budget_cents: 100 });
    const opened = await context.issueBudgets.open(id, { budgetCents: 100 });
    if (!opened.ok) throw new Error('open failed');

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ budget_cents: 300 }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ budgetCents: 300 });
    // The key already exists, so the raise must reach OpenRouter as well as the
    // local Issue; otherwise the next attempt would still be capped at $1.
    expect(context.budgetApi.lastUpdate).toEqual({
      hash: opened.value.keyHash,
      input: { limitUsd: 3 },
    });
    const summary = await context.issueBudgets.summary(id, 300);
    expect(summary.ok && summary.value.remainingCents).toBe(300);
  });

  it('updates the Issue budget without a key without calling OpenRouter', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const { id } = await createIssue(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ budget_cents: 250 }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ budgetCents: 250 });
    expect(context.budgetApi.calls).toEqual([]);
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
