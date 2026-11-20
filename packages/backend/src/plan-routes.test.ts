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

async function savePlan(
  context: TestContext,
  session: string,
  projectId: string,
  contentMarkdown = '# Plan',
): Promise<string> {
  const res = await request(context, session, `/api/projects/${projectId}/plans`, {
    method: 'POST',
    body: JSON.stringify({ content_markdown: contentMarkdown, mode: 'guided' }),
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
        mode: 'guided',
        source: 'grill-me',
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      projectId,
      version: 1,
      contentMarkdown: '# Plan',
      mode: 'guided',
      source: 'grill-me',
      isActive: true,
    });
    await expect(context.plans.list(projectId)).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ version: 1 })],
    });
  });

  it('stores a supplied summary and derives one when absent', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const supplied = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ content_markdown: '# Plan', summary: '  Save   bookmarks. ' }),
    });
    const derived = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({
        content_markdown: '# Plan\n\nDevelopers lose their links.',
      }),
    });

    expect(supplied.status).toBe(201);
    await expect(supplied.json()).resolves.toMatchObject({ summary: 'Save bookmarks.' });
    expect(derived.status).toBe(201);
    await expect(derived.json()).resolves.toMatchObject({
      summary: 'Developers lose their links.',
    });
  });

  it('rejects an over-long summary with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ content_markdown: '# Plan', summary: 'x'.repeat(201) }),
    });

    expect(res.status).toBe(400);
  });

  it('defaults the project mode to the project', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ content_markdown: '# Plan' }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ mode: 'guided' });
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

/** Saves a Plan directly through the module and returns its id. */
async function newPlan(
  context: TestContext,
  projectId: string,
  content = '# Plan',
): Promise<string> {
  const result = await context.plans.create({
    projectId,
    contentMarkdown: content,
    mode: 'guided',
    source: 'grill-me',
  });
  if (!result.ok) throw new Error('plan setup failed');
  return result.value.id;
}

/** Adds an Issue to a Plan and returns it. */
async function addPlanIssue(
  context: TestContext,
  projectId: string,
  planId: string,
  input: {
    title: string;
    label?: 'ready' | 'refinement-needed' | 'needs-human';
    dependsOn?: string[];
  },
) {
  const result = await context.issues.create({ projectId, planId, ...input });
  if (!result.ok) throw new Error(`issue setup failed: ${result.error.message}`);
  return result.value;
}

describe('POST /api/projects/:id/plans/:planId/accept', () => {
  it('accepts the active plan and syncs only that plan\u2019s issues, keeping their labels', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const previous = await newPlan(context, projectId, '# Previous');
    const active = await newPlan(context, projectId, '# Active');
    await addPlanIssue(context, projectId, previous, {
      title: 'Old work',
      label: 'needs-human',
    });
    await addPlanIssue(context, projectId, active, {
      title: 'New work',
      label: 'refinement-needed',
    });

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/plans/${active}/accept`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; acceptedAt: string | null };
    expect(body.id).toBe(active);
    expect(body.acceptedAt).not.toBeNull();
    expect(context.github.issues('acme/todo-app').map((issue) => issue.title)).toEqual([
      'New work',
    ]);

    const listed = await context.issues.list(projectId);
    if (!listed.ok) throw new Error('list failed');
    const oldIssue = listed.value.find((issue) => issue.title === 'Old work');
    const newIssue = listed.value.find((issue) => issue.title === 'New work');
    expect(oldIssue?.githubNumber).toBeNull();
    expect(oldIssue?.label).toBe('needs-human');
    expect(newIssue?.githubNumber).not.toBeNull();
    expect(newIssue?.label).toBe('refinement-needed');
  });

  it('records the accepted Plan before publishing its Issues', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const plan = await newPlan(context, projectId, '# Overview\n\nKeep this verbatim.');
    await addPlanIssue(context, projectId, plan, { title: 'Schema' });
    await addPlanIssue(context, projectId, plan, {
      title: 'API',
      label: 'refinement-needed',
      dependsOn: ['Schema'],
    });
    let issuesAtWrite = -1;
    const write = context.contents.writeFile.bind(context.contents);
    context.contents.writeFile = async (...args) => {
      issuesAtWrite = context.github.issues('acme/todo-app').length;
      return write(...args);
    };

    const res = await request(context, session, `/api/projects/${projectId}/plans/${plan}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(issuesAtWrite).toBe(0);
    const files = context.contents.files('acme/todo-app');
    expect(files.map((file) => file.path)).toEqual(['docs/plans/v1.md']);
    const document = files[0]?.content ?? '';
    expect(document).toContain('# Plan v1 — todo-app');
    expect(document).toContain('# Overview\n\nKeep this verbatim.');
    expect(document).toContain('- **Schema** (`ready`)');
    expect(document).toContain('- **API** (`refinement-needed`) — depends on: Schema');
    expect(document).not.toContain(projectId);
    expect(document).not.toContain(plan);
  });

  it('links every pushed Issue to the accepted Plan\u2019s decision record', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await newPlan(context, projectId, '# Previous');
    const plan = await newPlan(context, projectId, '# Active');
    await addPlanIssue(context, projectId, plan, { title: 'Schema' });
    await addPlanIssue(context, projectId, plan, { title: 'API' });

    const res = await request(context, session, `/api/projects/${projectId}/plans/${plan}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const bodies = context.github.issues('acme/todo-app').map((issue) => issue.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.startsWith('Plan: docs/plans/v2.md\n\n')).toBe(true);
    }
  });

  it('reports a Plan commit failure as sync-failed and leaves the plan unaccepted', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const plan = await newPlan(context, projectId);
    await addPlanIssue(context, projectId, plan, { title: 'Schema' });
    context.contents.failNext('write-file', {
      kind: 'unauthorized',
      operation: 'write-file',
      message: 'Bad credentials',
    });

    const res = await request(context, session, `/api/projects/${projectId}/plans/${plan}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: 'sync-failed',
      message: 'Bad credentials',
    });
    const listed = await context.plans.list(projectId);
    expect(listed.ok && listed.value[0]?.acceptedAt).toBeNull();
    expect(context.github.issues('acme/todo-app')).toHaveLength(0);
  });

  it('rejects accepting a plan that is not active', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const previous = await newPlan(context, projectId, '# Previous');
    await newPlan(context, projectId, '# Active');
    await addPlanIssue(context, projectId, previous, { title: 'Old work' });

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/plans/${previous}/accept`,
      { method: 'POST' },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'not-acceptable',
      message: expect.stringMatching(/active/i),
    });
  });

  it('rejects accepting a plan with no issues', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const plan = await newPlan(context, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/plans/${plan}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'not-acceptable',
      message: expect.stringMatching(/at least one issue/i),
    });
    expect(context.github.issues('acme/todo-app')).toHaveLength(0);
  });

  it('rejects accepting a plan whose issues form a cycle', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const plan = await newPlan(context, projectId);
    await addPlanIssue(context, projectId, plan, { title: 'Schema', dependsOn: ['Api'] });
    await addPlanIssue(context, projectId, plan, { title: 'Api', dependsOn: ['Schema'] });

    const res = await request(context, session, `/api/projects/${projectId}/plans/${plan}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'not-acceptable',
      message: expect.stringMatching(/circular/i),
    });
    expect(context.github.issues('acme/todo-app')).toHaveLength(0);
  });

  it('rejects accepting a plan with a missing dependency', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const plan = await newPlan(context, projectId);
    await addPlanIssue(context, projectId, plan, { title: 'Api', dependsOn: ['Ghost'] });

    const res = await request(context, session, `/api/projects/${projectId}/plans/${plan}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'not-acceptable',
      message: expect.stringMatching(/missing/i),
    });
    expect(context.github.issues('acme/todo-app')).toHaveLength(0);
  });

  it('leaves the plan unaccepted when GitHub fails, then accepts on retry', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const plan = await newPlan(context, projectId);
    await addPlanIssue(context, projectId, plan, { title: 'Schema' });
    context.github.failNext('create-issue', {
      kind: 'unauthorized',
      operation: 'create-issue',
      message: 'Bad credentials',
    });

    const failed = await request(
      context,
      session,
      `/api/projects/${projectId}/plans/${plan}/accept`,
      { method: 'POST' },
    );

    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: 'sync-failed',
      message: 'Bad credentials',
    });
    const listed = await context.plans.list(projectId);
    expect(listed.ok && listed.value[0]?.acceptedAt).toBeNull();

    const retried = await request(
      context,
      session,
      `/api/projects/${projectId}/plans/${plan}/accept`,
      { method: 'POST' },
    );

    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ id: plan });
    expect(context.github.issues('acme/todo-app').map((issue) => issue.title)).toEqual(['Schema']);
  });

  it('returns 404 for an unknown plan', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/plans/missing/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not-found' });
  });
});
