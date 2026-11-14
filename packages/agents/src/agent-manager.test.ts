import { describe, expect, it } from 'vitest';
import { createInMemoryIssueStore, createIssuesModule, type IssuesModule } from '@yaaabk/issues';
import { createMockK8sClient, type MockK8sClient } from '@yaaabk/k8s';
import { createInMemoryProjectStore, type Project } from '@yaaabk/projects';
import { createAgentManager, type AgentManagerOptions } from './agent-manager';
import { DEFAULT_ACTIVE_DEADLINE_SECONDS } from './config';
import { silentLogger } from './errors';
import { createInMemoryAgentStore } from './in-memory-agent-store';
import type { AgentManager } from './types';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const NS = 'project-a1b2c3d4';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'todo-app',
    description: 'A todo app',
    skillLevel: 'expert',
    repoUrl: 'https://github.com/acme/todo-app',
    repoFullName: 'acme/todo-app',
    namespace: NS,
    argoAppName: 'todo-app',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

interface Harness {
  manager: AgentManager;
  issues: IssuesModule;
  k8s: MockK8sClient;
}

async function harness(
  options: { maxPerProject?: number; maxCluster?: number; projects?: Project[] } = {},
): Promise<Harness> {
  const projectStore = createInMemoryProjectStore();
  for (const entry of options.projects ?? [project()]) {
    projectStore.create(entry);
  }

  let issueSequence = 0;
  const issues = createIssuesModule({
    store: createInMemoryIssueStore(),
    clock: () => NOW,
    ids: () => `issue-${++issueSequence}`,
    logger: silentLogger,
  });

  let runSequence = 0;
  let tokenSequence = 0;
  const managerOptions: AgentManagerOptions = {
    store: createInMemoryAgentStore(),
    issues,
    projects: projectStore,
    k8s: createMockK8sClient(),
    clock: () => NOW,
    ids: () => `run-${++runSequence}`,
    newToken: () => `token-${++tokenSequence}`,
    logger: silentLogger,
    ...(options.maxPerProject === undefined ? {} : { maxPerProject: options.maxPerProject }),
    ...(options.maxCluster === undefined ? {} : { maxCluster: options.maxCluster }),
  };
  const k8s = managerOptions.k8s as MockK8sClient;
  const manager = createAgentManager(managerOptions);

  return { manager, issues, k8s };
}

/** Creates an Issue and gives it a GitHub number, as an approved sync would. */
async function readyIssue(
  issues: IssuesModule,
  overrides: {
    projectId?: string;
    title?: string;
    githubNumber?: number;
    maxAttempts?: number;
  } = {},
) {
  const projectId = overrides.projectId ?? 'project-1';
  const created = await issues.create({
    projectId,
    title: overrides.title ?? 'Add login',
    ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
  });
  if (!created.ok) throw new Error(`issue create failed: ${created.error.message}`);
  const synced = await issues.update(projectId, created.value.id, {
    githubNumber: overrides.githubNumber ?? 42,
  });
  if (!synced.ok) throw new Error(`issue update failed: ${synced.error.message}`);
  return synced.value;
}

interface JobContainer {
  env?: Array<{ name: string; value: string }>;
  envFrom?: Array<{ secretRef: { name: string } }>;
  volumeMounts?: Array<{ name: string; mountPath: string }>;
}

async function readJobContainer(k8s: MockK8sClient, namespace: string, name: string) {
  const job = await k8s.objectApi.read({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace },
  });
  const spec = job.spec as {
    activeDeadlineSeconds: number;
    template: {
      spec: {
        serviceAccountName: string;
        containers: JobContainer[];
        volumes: Array<{ name: string; persistentVolumeClaim: { claimName: string } }>;
      };
    };
  };
  return { spec, container: spec.template.spec.containers[0]! };
}

/** Drives a Job to a terminal phase the way the API server would. */
async function finishJob(
  k8s: MockK8sClient,
  namespace: string,
  name: string,
  phase: 'succeeded' | 'failed',
): Promise<void> {
  await k8s.objectApi.patch({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace },
    status: {
      conditions: [{ type: phase === 'succeeded' ? 'Complete' : 'Failed', status: 'True' }],
    },
  });
}

describe('spawn', () => {
  it('dispatches a Job for a ready Issue and records a running attempt', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      projectId: 'project-1',
      issueId: issue.id,
      attemptNumber: 1,
      status: 'running',
      jobName: 'agent-issue-1-attempt-1',
      pvcName: 'agent-work-issue-1-1',
      startedAt: NOW.toISOString(),
    });
    expect(result.value).not.toHaveProperty('tokenHash');

    const advanced = await issues.get('project-1', issue.id);
    expect(advanced.ok && advanced.value).toMatchObject({
      status: 'in_progress',
      attemptCount: 1,
    });

    const { spec, container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({ name: 'ISSUE_NUMBER', value: '42' });
    expect(container.env).toContainEqual({
      name: 'REPO_URL',
      value: 'https://github.com/acme/todo-app',
    });
    expect(container.envFrom).toEqual([{ secretRef: { name: 'yaaabk-github' } }]);
    expect(spec.template.spec.serviceAccountName).toBe('yaaabk-agent');
    expect(container.volumeMounts).toEqual([{ name: 'work', mountPath: '/work' }]);
    expect(spec.template.spec.volumes).toEqual([
      { name: 'work', persistentVolumeClaim: { claimName: 'agent-work-issue-1-1' } },
    ]);
    expect(spec.activeDeadlineSeconds).toBe(DEFAULT_ACTIVE_DEADLINE_SECONDS);

    const pvc = await k8s.pvcs.get(NS, 'agent-work-issue-1-1');
    expect(pvc.ok).toBe(true);
  });

  it('provisions a per-attempt OpenRouter Secret the Job reads from', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, { openrouterApiKey: 'sk-or-key' });

    expect(result.ok && result.value.openrouterSecretName).toBe('agent-openrouter-issue-1-1');
    const secret = await k8s.secrets.get(NS, 'agent-openrouter-issue-1-1');
    expect(secret.ok && secret.value.keys).toEqual(['OPENROUTER_API_KEY']);
    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.envFrom).toEqual([
      { secretRef: { name: 'yaaabk-github' } },
      { secretRef: { name: 'agent-openrouter-issue-1-1' } },
    ]);
  });

  it('refuses an Issue that has not been synced to GitHub', async () => {
    const { manager, issues } = await harness();
    const created = await issues.create({ projectId: 'project-1', title: 'Add login' });
    if (!created.ok) throw new Error('setup failed');

    const result = await manager.spawn('project-1', created.value.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('issue-not-synced');
    }
  });
});

describe('concurrency', () => {
  it('queues the third attempt for a Project until one completes', async () => {
    const { manager, issues, k8s } = await harness();
    const first = await readyIssue(issues, { title: 'First', githubNumber: 1 });
    const second = await readyIssue(issues, { title: 'Second', githubNumber: 2 });
    const third = await readyIssue(issues, { title: 'Third', githubNumber: 3 });

    const a = await manager.spawn('project-1', first.id);
    const b = await manager.spawn('project-1', second.id);
    const c = await manager.spawn('project-1', third.id);

    expect(a.ok && a.value.status).toBe('running');
    expect(b.ok && b.value.status).toBe('running');
    expect(c.ok && c.value.status).toBe('queued');
    if (!a.ok) return;

    await finishJob(k8s, NS, a.value.jobName!, 'succeeded');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({ succeeded: 1, dispatched: 1 });
    const queued = await manager.runs('project-1', third.id);
    expect(queued.ok && queued.value[0]?.status).toBe('running');
  });

  it('enforces the cluster-wide limit across Projects', async () => {
    const { manager, issues } = await harness({
      maxPerProject: 10,
      maxCluster: 3,
      projects: [
        project({ id: 'p1', name: 'alpha', namespace: 'ns-1' }),
        project({ id: 'p2', name: 'beta', namespace: 'ns-2' }),
      ],
    });
    const a = await readyIssue(issues, { projectId: 'p1', title: 'A', githubNumber: 1 });
    const b = await readyIssue(issues, { projectId: 'p1', title: 'B', githubNumber: 2 });
    const c = await readyIssue(issues, { projectId: 'p2', title: 'C', githubNumber: 3 });
    const d = await readyIssue(issues, { projectId: 'p2', title: 'D', githubNumber: 4 });

    const results = await Promise.all([
      manager.spawn('p1', a.id),
      manager.spawn('p1', b.id),
      manager.spawn('p2', c.id),
      manager.spawn('p2', d.id),
    ]);

    const statuses = results.map((result) => (result.ok ? result.value.status : 'error'));
    expect(statuses).toEqual(['running', 'running', 'running', 'queued']);
    const capacity = manager.capacity();
    expect(capacity.ok && capacity.value).toMatchObject({ cluster: 3, maxCluster: 3 });
  });
});

describe('reconcile', () => {
  it('records a successful Job without closing the Issue, which CI still merges', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);
    const spawned = await manager.spawn('project-1', issue.id);
    if (!spawned.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, spawned.value.jobName!, 'succeeded');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({ succeeded: 1, failed: 0 });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value[0]).toMatchObject({
      status: 'success',
      finishedAt: NOW.toISOString(),
    });
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value.status).toBe('in_progress');
  });

  it('retries a failed attempt, then escalates once the attempts are exhausted', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues, { maxAttempts: 2 });
    const first = await manager.spawn('project-1', issue.id);
    if (!first.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, first.value.jobName!, 'failed');
    const firstPass = await manager.reconcile();

    expect(firstPass.ok && firstPass.value).toMatchObject({
      failed: 1,
      escalated: 0,
      dispatched: 1,
    });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value.map((run) => [run.attemptNumber, run.status])).toEqual([
      [1, 'failed'],
      [2, 'running'],
    ]);
    if (!runs.ok) return;
    const second = runs.value[1]!;

    await finishJob(k8s, NS, second.jobName!, 'failed');
    const secondPass = await manager.reconcile();

    expect(secondPass.ok && secondPass.value).toMatchObject({ failed: 1, escalated: 1 });
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ status: 'failed', label: 'needs-human' });
  });
});

describe('report', () => {
  it('records what the Job reports when it presents the run token', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);
    const spawned = await manager.spawn('project-1', issue.id);
    if (!spawned.ok) throw new Error('spawn failed');

    const { container } = await readJobContainer(k8s, NS, spawned.value.jobName!);
    const token = container.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    expect(token).toBeDefined();

    const denied = await manager.report(spawned.value.id, 'wrong-token', { prUrl: 'x' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe('unauthorized');

    const prUrl = 'https://github.com/acme/todo-app/pull/7';
    const reported = await manager.report(spawned.value.id, token!, { prUrl, costCents: 123 });

    expect(reported.ok && reported.value).toMatchObject({ prUrl, costCents: 123 });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value[0]).toMatchObject({ prUrl, costCents: 123 });
  });
});
