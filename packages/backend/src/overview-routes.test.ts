import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', mode: 'guided' } as const;

async function request(
  context: TestContext,
  path: string,
  session?: string,
  init: RequestInit = {},
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

async function createProject(context: TestContext, name: string = PROJECT.name): Promise<string> {
  const created = await context.projects.create({ ...PROJECT, name });
  if (!created.ok) throw new Error('create failed');
  return created.value.id;
}

async function savePlan(context: TestContext, session: string, projectId: string): Promise<string> {
  const res = await request(context, `/api/projects/${projectId}/plans`, session, {
    method: 'POST',
    body: JSON.stringify({ content_markdown: '# Plan', mode: 'guided' }),
  });
  if (res.status !== 201) throw new Error('plan create failed');
  return ((await res.json()) as { id: string }).id;
}

describe('GET /api/projects/:id/overview', () => {
  it('returns the overview for a project with no plan, issues or runs', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, `/api/projects/${projectId}/overview`, session);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      project: { id: projectId, name: 'todo-app' },
      activePlan: null,
      activeWork: [],
      issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0 },
      lastRunAt: null,
    });
  });

  it('summarizes the active plan, unaccepted until the Developer accepts it', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const planId = await savePlan(context, session, projectId);

    const res = await request(context, `/api/projects/${projectId}/overview`, session);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      activePlan: { id: planId, version: 1, acceptedAt: null },
    });
  });

  it('counts issues and lists the in-flight runs with their issue titles', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const created = await context.issues.create({ projectId, title: 'Add login' });
    if (!created.ok) throw new Error('issue create failed');
    await context.issues.update(projectId, created.value.id, { githubNumber: 42 });
    const spawned = await context.agents.spawn(projectId, created.value.id);
    if (!spawned.ok) throw new Error('spawn failed');

    const res = await request(context, `/api/projects/${projectId}/overview`, session);

    expect(res.status).toBe(200);
    const overview = (await res.json()) as {
      activeWork: Array<Record<string, unknown>>;
      issues: Record<string, number>;
      lastRunAt: string | null;
    };
    expect(overview.issues).toMatchObject({ total: 1, inProgress: 1 });
    expect(overview.activeWork).toEqual([
      expect.objectContaining({
        id: spawned.value.id,
        issueId: created.value.id,
        issueTitle: 'Add login',
        kind: 'implement-issue',
        attemptNumber: 1,
        status: 'running',
      }),
    ]);
    expect(overview.lastRunAt).toBe(spawned.value.createdAt);
  });

  it('returns 404 for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, '/api/projects/missing/overview', session);

    expect(res.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const { context } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, `/api/projects/${projectId}/overview`);

    expect(res.status).toBe(401);
  });
});

describe('GET /api/overview', () => {
  it('returns one overview per project, with the active plan of each', async () => {
    const { context, session } = await signedIn();
    const first = await createProject(context, 'todo-app');
    const second = await createProject(context, 'notes-app');
    const planId = await savePlan(context, session, first);

    const res = await request(context, '/api/overview', session);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overviews: Array<{
        project: { id: string; name: string };
        activePlan: { id: string } | null;
      }>;
    };
    expect(body.overviews).toHaveLength(2);
    expect(body.overviews.map((overview) => overview.project.name).sort()).toEqual([
      'notes-app',
      'todo-app',
    ]);
    expect(body.overviews.find((overview) => overview.project.id === first)?.activePlan).toEqual(
      expect.objectContaining({ id: planId }),
    );
    expect(
      body.overviews.find((overview) => overview.project.id === second)?.activePlan,
    ).toBeNull();
  });

  it('rejects an unauthenticated request', async () => {
    const { context } = await signedIn();

    const res = await request(context, '/api/overview');

    expect(res.status).toBe(401);
  });
});
