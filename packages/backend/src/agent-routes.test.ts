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
  options: { githubNumber?: number | null; name?: string } = {},
): Promise<{ projectId: string; issueId: string }> {
  const created = await context.projects.create({ ...PROJECT, name: options.name ?? PROJECT.name });
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

describe('GET /api/projects/:id/agent-runs/:runId/logs', () => {
  /** The report token and Job details a spawned run's Pod was given. */
  async function spawnedRun(
    context: TestContext,
    session: string,
    projectId: string,
    issueId: string,
  ): Promise<{ runId: string; token: string }> {
    const res = await request(
      context,
      `/api/projects/${projectId}/issues/${issueId}/spawn`,
      { method: 'POST', body: JSON.stringify({}) },
      session,
    );
    expect(res.status).toBe(202);
    const run = (await res.json()) as { id: string };

    const namespace = context.projectStore.get(projectId)?.namespace ?? '';
    const job = await context.k8s.objectApi.read({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: `agent-${issueId}-attempt-1`, namespace },
    });
    const containers = (
      job.spec as {
        template: { spec: { containers: Array<{ env?: Array<{ name: string; value: string }> }> } };
      }
    ).template.spec.containers;
    const token = containers[0]?.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    if (token === undefined) throw new Error('the Job was not given a report token');
    return { runId: run.id, token };
  }

  it('rejects an unauthenticated request', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);
    const { runId } = await spawnedRun(context, session, projectId, issueId);

    const res = await request(context, `/api/projects/${projectId}/agent-runs/${runId}/logs`);

    expect(res.status).toBe(401);
  });

  it('streams the log a run has so far and ends the stream', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);
    const { runId, token } = await spawnedRun(context, session, projectId, issueId);
    await request(context, `/api/agent-runs/${runId}/report`, {
      method: 'POST',
      body: JSON.stringify({ token, logs: '[yaaabk] cloning repo\n' }),
    });

    const res = await request(
      context,
      `/api/projects/${projectId}/agent-runs/${runId}/logs`,
      {},
      session,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: log');
    expect(body).toContain('cloning repo');
    expect(body).toContain('event: end');
  });

  it('reports a run from another project as not-found', async () => {
    const { context, session } = await signedIn();
    const first = await projectWithIssue(context, session);
    const second = await projectWithIssue(context, session, { name: 'other-app' });
    const { runId } = await spawnedRun(context, session, first.projectId, first.issueId);

    const res = await request(
      context,
      `/api/projects/${second.projectId}/agent-runs/${runId}/logs`,
      {},
      session,
    );

    expect(res.status).toBe(404);
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
    // The Job runs in the Project's namespace as the Project's `yaaabk-agent` SA.
    const job = await context.k8s.objectApi.read({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: run.jobName, namespace: project.value.namespace },
    });
    const podSpec = (
      job.spec as {
        template: {
          spec: {
            serviceAccountName: string;
            containers: Array<{ env: Array<{ name: string; value: string }> }>;
          };
        };
      }
    ).template.spec;
    expect(podSpec.serviceAccountName).toBe('yaaabk-agent');
    const container = podSpec.containers[0]!;
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

  it('records the token usage reported by the run', async () => {
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
    const token = (
      job.spec as {
        template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } };
      }
    ).template.spec.containers[0]!.env.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;

    const tokens = {
      input: 1_200,
      output: 300,
      reasoning: 40,
      cache: { read: 5_000, write: 10 },
    };
    const reported = await request(context, `/api/agent-runs/${run.id}/report`, {
      method: 'POST',
      body: JSON.stringify({ token, prUrl: 'https://github.com/acme/todo/pull/7', tokens }),
    });

    expect(reported.status).toBe(200);
    await expect(reported.json()).resolves.toMatchObject({ tokens });
  });

  it('rejects a partial or negative token payload without recording it', async () => {
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
    const token = (
      job.spec as {
        template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } };
      }
    ).template.spec.containers[0]!.env.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;

    const invalid = [
      { input: 1, output: 2, reasoning: 3, cache: { read: 4 } },
      { input: -1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      { input: 1.5, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      'many',
    ];
    for (const tokens of invalid) {
      const rejected = await request(context, `/api/agent-runs/${run.id}/report`, {
        method: 'POST',
        body: JSON.stringify({ token, tokens }),
      });
      expect(rejected.status).toBe(400);
    }

    const runs = await context.agents.runs(projectId, issueId);
    expect(runs.ok && runs.value[0]?.tokens).toBeNull();
  });

  it('records a failed deploy reported with its outcome', async () => {
    const { context, session } = await signedIn();
    const { projectId, issueId } = await projectWithIssue(context, session);
    const githubIssue = await context.github.createIssue('acme/todo-app', {
      title: 'Add login',
      body: '',
      labels: ['ready'],
    });
    if (!githubIssue.ok) throw new Error('github issue missing');
    await context.issues.update(projectId, issueId, { githubNumber: githubIssue.value.number });

    const spawned = await context.agents.spawn(projectId, issueId, {
      kind: 'deploy',
      commitSha: 'sha-merged-7',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    const project = await context.projects.get(projectId);
    if (!project.ok) throw new Error('project missing');
    const job = await context.k8s.objectApi.read({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: spawned.value.jobName!, namespace: project.value.namespace },
    });
    const container = (
      job.spec as {
        template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } };
      }
    ).template.spec.containers[0]!;
    const token = container.env.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    expect(token).toBeDefined();

    const reported = await request(context, `/api/agent-runs/${spawned.value.id}/report`, {
      method: 'POST',
      body: JSON.stringify({
        token,
        logs: 'rollout failed\nPod logs:\nError: CrashLoopBackOff',
        commitSha: 'sha-merged-7',
        deployOutcome: 'failed',
      }),
    });

    expect(reported.status).toBe(200);
    expect(context.projectStore.get(projectId)).toMatchObject({
      deployedCommitSha: null,
      lastDeployStatus: 'failed',
    });
    expect(context.github.issues('acme/todo-app')[0]?.labels).toContain('deploy-failed');
  });
});
