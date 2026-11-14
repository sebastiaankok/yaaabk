import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' } as const;

async function request(
  context: TestContext,
  path: string,
  init: RequestInit = {},
  session?: string,
): Promise<Response> {
  return context.app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { cookie: `${SESSION_COOKIE}=${session}` }),
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

describe('GET /api/projects/:id/stats', () => {
  it('rejects an unauthenticated request', async () => {
    const { context } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, `/api/projects/${projectId}/stats`);

    expect(res.status).toBe(401);
  });

  it('returns zeroed stats for a project with no issues or runs', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, `/api/projects/${projectId}/stats`, {}, session);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
      agents: {
        total: 0,
        successRate: null,
        totalCostCents: 0,
        duration: { averageSeconds: null, minSeconds: null, maxSeconds: null },
      },
      costByIssue: [],
      runs: [],
    });
  });

  it('aggregates the project issues and agent runs', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const created = await context.issues.create({ projectId, title: 'Add login' });
    if (!created.ok) throw new Error('issue create failed');
    await context.issues.update(projectId, created.value.id, { githubNumber: 42 });
    const spawned = await context.agents.spawn(projectId, created.value.id);
    if (!spawned.ok) throw new Error('spawn failed');

    const res = await request(context, `/api/projects/${projectId}/stats`, {}, session);

    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      issues: { total: number; open: number };
      agents: { total: number; active: number };
      runs: Array<{ issueTitle: string; status: string }>;
    };
    expect(stats.issues).toMatchObject({ total: 1, open: 0, inProgress: 1 });
    expect(stats.agents).toMatchObject({ total: 1, active: 1 });
    expect(stats.runs).toEqual([
      expect.objectContaining({ issueTitle: 'Add login', status: 'running' }),
    ]);
  });

  it('rejects an invalid range', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(
      context,
      `/api/projects/${projectId}/stats?from=yesterday`,
      {},
      session,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });

  it('returns 404 for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, '/api/projects/missing/stats', {}, session);

    expect(res.status).toBe(404);
  });
});
