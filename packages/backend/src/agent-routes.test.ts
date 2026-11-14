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

async function projectWithIssue(
  context: TestContext,
  session: string,
  options: { githubNumber?: number | null } = {},
): Promise<{ projectId: string; issueId: string }> {
  const created = await context.projects.create(PROJECT);
  if (!created.ok) throw new Error('create failed');
  const projectId = created.value.id;

  const issueRes = await request(
    context,
    `/api/projects/${projectId}/issues`,
    { method: 'POST', body: JSON.stringify({ title: 'Add login' }) },
    session,
  );
  expect(issueRes.status).toBe(201);
  const issue = (await issueRes.json()) as { id: string };

  if (options.githubNumber !== null) {
    const patch = await request(
      context,
      `/api/projects/${projectId}/issues/${issue.id}`,
      { method: 'PATCH', body: JSON.stringify({ github_number: options.githubNumber ?? 42 }) },
      session,
    );
    expect(patch.status).toBe(200);
  }

  return { projectId, issueId: issue.id };
}

describe('POST /api/projects/:id/issues/:issueId/spawn', () => {
  it('rejects an unauthenticated request', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);

    const res = await request(context, `/api/projects/${projectId}/issues/${issueId}/spawn`, {
      method: 'POST',
    });

    expect(res.status).toBe(401);
  });

  it('schedules an attempt for a synced Issue', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);

    const res = await request(
      context,
      `/api/projects/${projectId}/issues/${issueId}/spawn`,
      { method: 'POST', body: JSON.stringify({}) },
      session,
    );

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      projectId,
      issueId,
      attemptNumber: 1,
      status: 'running',
    });
  });

  it('reports an Issue that is not yet synced to GitHub as a conflict', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session, {
      githubNumber: null,
    });

    const res = await request(
      context,
      `/api/projects/${projectId}/issues/${issueId}/spawn`,
      { method: 'POST', body: JSON.stringify({}) },
      session,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'issue-not-synced' });
  });

  it('lists the attempts for an Issue', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);
    await request(
      context,
      `/api/projects/${projectId}/issues/${issueId}/spawn`,
      { method: 'POST', body: JSON.stringify({}) },
      session,
    );

    const res = await request(
      context,
      `/api/projects/${projectId}/issues/${issueId}/runs`,
      {},
      session,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      runs: [expect.objectContaining({ issueId, attemptNumber: 1 })],
    });
  });
});

describe('POST /api/agent-runs/:runId/report', () => {
  it('accepts a report authenticated by the run token, with no session', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);
    const spawned = await request(
      context,
      `/api/projects/${projectId}/issues/${issueId}/spawn`,
      { method: 'POST', body: JSON.stringify({}) },
      session,
    );
    const run = (await spawned.json()) as { id: string; jobName: string };

    const project = await context.projects.get(projectId);
    if (!project.ok) throw new Error('project missing');
    const job = await context.k8s.objectApi.read({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: run.jobName, namespace: project.value.namespace },
    });
    const container = (
      job.spec as {
        template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } };
      }
    ).template.spec.containers[0]!;
    const token = container.env.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    expect(token).toBeDefined();

    const denied = await request(context, `/api/agent-runs/${run.id}/report`, {
      method: 'POST',
      body: JSON.stringify({ token: 'wrong', prUrl: 'x' }),
    });
    expect(denied.status).toBe(401);

    const accepted = await request(context, `/api/agent-runs/${run.id}/report`, {
      method: 'POST',
      body: JSON.stringify({ token, prUrl: 'https://github.com/acme/todo/pull/7' }),
    });

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      prUrl: 'https://github.com/acme/todo/pull/7',
    });
  });
});
