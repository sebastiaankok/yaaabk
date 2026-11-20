import { describe, expect, it } from 'vitest';
import { createFakeGitHubIssues, type FakeGitHubIssues } from '@yaaabk/github';
import {
  createInMemoryIssueStore,
  createIssuesModule,
  type IssueLabel,
  type IssuesModule,
} from '@yaaabk/issues';
import { createMockK8sClient, type K8sObject, type MockK8sClient } from '@yaaabk/k8s';
import { createInMemoryProjectStore, type Project, type ProjectStore } from '@yaaabk/projects';
import { createAgentManager, type AgentManagerOptions } from './agent-manager';
import {
  AGENT_OPENCODE_CONFIG_PATH,
  DEFAULT_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_AGENT_MODEL,
} from './config';
import { silentLogger } from './errors';
import { createInMemoryAgentStore } from './in-memory-agent-store';
import type { AgentGithubTokenResolver, AgentManager } from './types';

const NOW = new Date('2026-01-01T12:00:00.000Z');
/** The Project's namespace, where its agent Jobs, PVCs and Secrets live. */
const NS = 'yaaabk-a1b2c3d4';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'todo-app',
    description: 'A todo app',
    mode: 'guided',
    repoUrl: 'https://github.com/acme/todo-app',
    repoFullName: 'acme/todo-app',
    namespace: NS,
    lastModel: null,
    agentModel: null,
    deployedCommitSha: null,
    lastDeployStatus: null,
    lastDeployAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

interface Harness {
  manager: AgentManager;
  /** The options the manager was built with, for a second manager over one store. */
  options: AgentManagerOptions;
  issues: IssuesModule;
  k8s: MockK8sClient;
  projects: ProjectStore;
  github: FakeGitHubIssues;
  /** Every token scope the manager asked for, in order. */
  scopes: string[];
}

async function harness(
  options: {
    maxPerProject?: number;
    maxCluster?: number;
    projects?: Project[];
    githubToken?: string | AgentGithubTokenResolver;
    model?: string;
    storageClassName?: string;
    mintOpenrouterKey?: AgentManagerOptions['mintOpenrouterKey'];
    /** Objects the fake cluster starts with, e.g. a Job's Pod. */
    seed?: K8sObject[];
    /** Scripted Pod output keyed by `namespace/name`. */
    logs?: Record<string, string>;
  } = {},
): Promise<Harness> {
  const projectStore = createInMemoryProjectStore();
  for (const entry of options.projects ?? [project()]) {
    projectStore.create(entry);
  }

  const github = createFakeGitHubIssues();

  let issueSequence = 0;
  const issues = createIssuesModule({
    store: createInMemoryIssueStore(),
    clock: () => NOW,
    ids: () => `issue-${++issueSequence}`,
    logger: silentLogger,
  });

  let runSequence = 0;
  let tokenSequence = 0;
  const scopes: string[] = [];
  const configuredToken = options.githubToken;
  const githubToken: AgentGithubTokenResolver | string | undefined =
    typeof configuredToken === 'function'
      ? async (scope) => {
          scopes.push(scope);
          return configuredToken(scope);
        }
      : configuredToken;
  const managerOptions: AgentManagerOptions = {
    store: createInMemoryAgentStore(),
    issues,
    projects: projectStore,
    k8s: createMockK8sClient({
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.logs === undefined ? {} : { logs: options.logs }),
    }),
    githubIssues: github,
    clock: () => NOW,
    ids: () => `run-${++runSequence}`,
    newToken: () => `token-${++tokenSequence}`,
    logger: silentLogger,
    ...(options.maxPerProject === undefined ? {} : { maxPerProject: options.maxPerProject }),
    ...(options.maxCluster === undefined ? {} : { maxCluster: options.maxCluster }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.storageClassName === undefined
      ? {}
      : { storageClassName: options.storageClassName }),
    ...(options.mintOpenrouterKey === undefined
      ? {}
      : { mintOpenrouterKey: options.mintOpenrouterKey }),
    ...(githubToken === undefined ? {} : { githubToken }),
  };
  const k8s = managerOptions.k8s as MockK8sClient;
  const manager = createAgentManager(managerOptions);

  return { manager, options: managerOptions, issues, k8s, projects: projectStore, github, scopes };
}

/** Creates an Issue and gives it a GitHub number, as an approved sync would. */
async function readyIssue(
  issues: IssuesModule,
  overrides: {
    projectId?: string;
    title?: string;
    githubNumber?: number;
    maxAttempts?: number;
    agentModel?: string;
    dependsOn?: string[];
    label?: IssueLabel;
  } = {},
) {
  const projectId = overrides.projectId ?? 'project-1';
  const created = await issues.create({
    projectId,
    title: overrides.title ?? 'Add login',
    ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
    ...(overrides.agentModel === undefined ? {} : { agentModel: overrides.agentModel }),
    ...(overrides.dependsOn === undefined ? {} : { dependsOn: overrides.dependsOn }),
    ...(overrides.label === undefined ? {} : { label: overrides.label }),
  });
  if (!created.ok) throw new Error(`issue create failed: ${created.error.message}`);
  const synced = await issues.update(projectId, created.value.id, {
    githubNumber: overrides.githubNumber ?? 42,
  });
  if (!synced.ok) throw new Error(`issue update failed: ${synced.error.message}`);
  return synced.value;
}

interface JobContainer {
  image?: string;
  imagePullPolicy?: string;
  env?: Array<{ name: string; value: string }>;
  envFrom?: Array<{ secretRef: { name: string } }>;
  volumeMounts?: Array<{ name: string; mountPath: string }>;
  securityContext?: Record<string, unknown>;
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
        securityContext?: Record<string, unknown>;
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
    expect(container.env).toContainEqual({
      name: 'OPENCODE_CONFIG',
      value: AGENT_OPENCODE_CONFIG_PATH,
    });
    expect(container.envFrom).toEqual([]);
    expect(spec.template.spec.serviceAccountName).toBe('yaaabk-agent');
    expect(container.volumeMounts).toEqual([{ name: 'work', mountPath: '/work' }]);
    // A re-pushed release tag must reach the attempt: the node otherwise keeps
    // the image it first pulled under that tag.
    expect(container.imagePullPolicy).toBe('Always');
    expect(spec.template.spec.volumes).toEqual([
      { name: 'work', persistentVolumeClaim: { claimName: 'agent-work-issue-1-1' } },
    ]);
    expect(spec.activeDeadlineSeconds).toBe(DEFAULT_ACTIVE_DEADLINE_SECONDS);
    // Project namespaces enforce Pod Security `restricted`, so a Job that omits
    // these fields never gets a Pod.
    expect(spec.template.spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });

    const pvc = await k8s.pvcs.get(NS, 'agent-work-issue-1-1');
    expect(pvc.ok).toBe(true);
    // Nothing is provisioned in the shared `yaaabk` namespace.
    const sharedPvc = await k8s.pvcs.get('yaaabk', 'agent-work-issue-1-1');
    expect(sharedPvc.ok).toBe(false);
  });

  it('gives Agent Jobs a git identity so they can commit without configuring one', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id);

    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({ name: 'GIT_AUTHOR_NAME', value: 'yaaabk' });
    expect(container.env).toContainEqual({ name: 'GIT_AUTHOR_EMAIL', value: 'agent@yaaabk.io' });
    expect(container.env).toContainEqual({ name: 'GIT_COMMITTER_NAME', value: 'yaaabk' });
    expect(container.env).toContainEqual({
      name: 'GIT_COMMITTER_EMAIL',
      value: 'agent@yaaabk.io',
    });
  });

  it('requests the configured StorageClass for the working PVC', async () => {
    const { manager, issues, k8s } = await harness({ storageClassName: 'local-path' });
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id);

    const pvc = await k8s.objectApi.read({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'agent-work-issue-1-1', namespace: NS },
    });
    expect((pvc.spec as Record<string, unknown>).storageClassName).toBe('local-path');
  });

  it('gives implement and review Jobs the configured OpenCode model', async () => {
    const { manager, issues, k8s } = await harness({ model: 'openrouter/agent-model' });
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id);
    await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });

    const implement = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(implement.container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: 'openrouter/agent-model',
    });
    const review = await readJobContainer(k8s, NS, 'agent-review-issue-1-1');
    expect(review.container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: 'openrouter/agent-model',
    });
  });

  it('falls back to the shared OpenCode model when none is configured', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id);

    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: DEFAULT_AGENT_MODEL,
    });
  });

  it('uses the project agent model when the issue has no override', async () => {
    const { manager, issues, k8s } = await harness({
      model: 'openrouter/env-model',
      projects: [project({ agentModel: 'openrouter/project-model' })],
    });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok && result.value.model).toBe('openrouter/project-model');
    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: 'openrouter/project-model',
    });
  });

  it('lets the issue model override the project and environment defaults', async () => {
    const { manager, issues, k8s } = await harness({
      model: 'openrouter/env-model',
      projects: [project({ agentModel: 'openrouter/project-model' })],
    });
    const issue = await readyIssue(issues, { agentModel: 'openrouter/issue-model' });

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok && result.value.model).toBe('openrouter/issue-model');
    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: 'openrouter/issue-model',
    });
  });

  it('uses the environment default when neither the issue nor project choose a model', async () => {
    const { manager, issues, k8s } = await harness({ model: 'openrouter/env-model' });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok && result.value.model).toBe('openrouter/env-model');
    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: 'openrouter/env-model',
    });
  });

  it('resolves the model when a queued run is dispatched, not when it is scheduled', async () => {
    const first = await harness({ maxPerProject: 0 });
    const issue = await readyIssue(first.issues);

    const queued = await first.manager.spawn('project-1', issue.id);
    expect(queued.ok && queued.value.status).toBe('queued');
    expect(queued.ok && queued.value.model).toBeNull();

    const current = first.projects.get('project-1')!;
    first.projects.update({ ...current, agentModel: 'openrouter/updated-model' });

    const manager = createAgentManager({ ...first.options, maxPerProject: 10 });
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value.dispatched).toBe(1);
    const runs = await manager.projectRuns('project-1');
    expect(runs.ok && runs.value[0]).toMatchObject({
      status: 'running',
      model: 'openrouter/updated-model',
    });
    const { container } = await readJobContainer(first.k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({
      name: 'AGENT_MODEL',
      value: 'openrouter/updated-model',
    });
  });

  it('provisions a per-attempt OpenRouter Secret the Job reads from', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, { openrouterApiKey: 'sk-or-key' });

    expect(result.ok && result.value.openrouterSecretName).toBe('agent-openrouter-issue-1-1');
    const secret = await k8s.secrets.get(NS, 'agent-openrouter-issue-1-1');
    expect(secret.ok && secret.value.keys).toEqual(['OPENROUTER_API_KEY']);
    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.envFrom).toEqual([{ secretRef: { name: 'agent-openrouter-issue-1-1' } }]);
  });

  it('mints a budgeted OpenRouter key for each attempt, including retries', async () => {
    const calls: Array<{ issueId: string; attempt: number; budgetCents: number; model: string }> =
      [];
    const { manager, issues, k8s } = await harness({
      mintOpenrouterKey: async (issue, attemptNumber, model) => {
        calls.push({
          issueId: issue.id,
          attempt: attemptNumber,
          budgetCents: issue.budgetCents,
          model,
        });
        return { ok: true, key: `sk-attempt-${attemptNumber}`, hash: `hash-${attemptNumber}` };
      },
    });
    const issue = await readyIssue(issues);

    const spawned = await manager.spawn('project-1', issue.id);

    expect(spawned.ok && spawned.value.openrouterSecretName).toBe('agent-openrouter-issue-1-1');
    expect(calls).toEqual([
      {
        issueId: issue.id,
        attempt: 1,
        budgetCents: issue.budgetCents,
        model: DEFAULT_AGENT_MODEL,
      },
    ]);
    const firstSecret = await k8s.objectApi.read({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'agent-openrouter-issue-1-1', namespace: NS },
    });
    expect(firstSecret.data).toEqual({
      OPENROUTER_API_KEY: Buffer.from('sk-attempt-1').toString('base64'),
    });
    const advanced = await issues.get('project-1', issue.id);
    expect(advanced.ok && advanced.value.openrouterKeyHash).toBe('hash-1');

    // A failed attempt retries with a fresh key; the retry path must not fall
    // back to a Job with no credential.
    await finishJob(k8s, NS, 'agent-issue-1-attempt-1', 'failed');
    const reconciled = await manager.reconcile();

    expect(reconciled.ok && reconciled.value.dispatched).toBe(1);
    expect(calls).toEqual([
      { issueId: issue.id, attempt: 1, budgetCents: issue.budgetCents, model: DEFAULT_AGENT_MODEL },
      { issueId: issue.id, attempt: 2, budgetCents: issue.budgetCents, model: DEFAULT_AGENT_MODEL },
    ]);
    const retrySecret = await k8s.objectApi.read({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'agent-openrouter-issue-1-2', namespace: NS },
    });
    expect(retrySecret.data).toEqual({
      OPENROUTER_API_KEY: Buffer.from('sk-attempt-2').toString('base64'),
    });
  });

  it('does not create a Job when the OpenRouter key cannot be minted', async () => {
    const { manager, issues, k8s } = await harness({
      mintOpenrouterKey: async () => ({
        ok: false,
        message: 'OpenRouter is not configured: add a management key in Settings.',
      }),
    });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('management key');
    const jobs = await k8s.jobs.list(NS);
    expect(jobs.ok && jobs.value).toEqual([]);
    const advanced = await issues.get('project-1', issue.id);
    expect(advanced.ok && advanced.value.attemptCount).toBe(0);
  });

  it('reports a budget refusal as such, with the amounts the Developer must change', async () => {
    const { manager, issues, k8s } = await harness({
      mintOpenrouterKey: async () => ({
        ok: false,
        reason: 'reply-reservation',
        message:
          '$0.10 remains of Issue issue-1’s $2.00 budget after $1.90 spent, but the model can reserve up to $0.96 for one reply.',
      }),
    });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('budget-exhausted');
    expect(result.error.message).toContain('$0.10 remains');
    expect(result.error.message).toContain('$1.90 spent');
    const jobs = await k8s.jobs.list(NS);
    expect(jobs.ok && jobs.value).toEqual([]);
  });

  it('provisions a per-attempt GitHub token Secret in the agent namespace', async () => {
    const { manager, issues, k8s } = await harness({ githubToken: 'ghs_fresh_installation_token' });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The run's short-lived GitHub token rides in its own Secret, minted per
    // dispatch, rather than a long-lived credential copied into every Project.
    const secret = await k8s.secrets.get(NS, 'agent-github-issue-1-1');
    expect(secret.ok && secret.value.keys).toEqual(['GITHUB_TOKEN']);
    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.envFrom).toEqual([{ secretRef: { name: 'agent-github-issue-1-1' } }]);
  });

  it("passes a fix attempt's branch to the Job", async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id, { branch: 'agent/issue-42' });

    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({ name: 'BRANCH', value: 'agent/issue-42' });
  });

  it("passes a fix attempt's reviewer feedback to the Job", async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id, {
      branch: 'agent/issue-42',
      reviewFeedback: 'Please rename the helper.',
    });

    const { container } = await readJobContainer(k8s, NS, 'agent-issue-1-attempt-1');
    expect(container.env).toContainEqual({
      name: 'REVIEW_FEEDBACK',
      value: 'Please rename the helper.',
    });
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

describe('autoDispatch', () => {
  it('starts the current wave only, then the next once its dependency closes', async () => {
    const { manager, issues } = await harness();
    const first = await readyIssue(issues, { title: 'Schema', githubNumber: 1 });
    const second = await readyIssue(issues, {
      title: 'Api',
      githubNumber: 2,
      dependsOn: ['Schema'],
    });

    const firstPass = await manager.autoDispatch();

    expect(firstPass.ok && firstPass.value).toEqual({ scheduled: 1 });
    const firstRuns = await manager.runs('project-1', first.id);
    expect(firstRuns.ok && firstRuns.value).toHaveLength(1);
    const secondRuns = await manager.runs('project-1', second.id);
    expect(secondRuns.ok && secondRuns.value).toHaveLength(0);
    const waiting = await issues.get('project-1', second.id);
    expect(waiting.ok && waiting.value).toMatchObject({ status: 'open', attemptCount: 0 });

    // The CI tracker closes the first Issue when its pull request merges.
    await issues.update('project-1', first.id, {
      status: 'closed',
      closedAt: NOW.toISOString(),
    });
    const secondPass = await manager.autoDispatch();

    expect(secondPass.ok && secondPass.value).toEqual({ scheduled: 1 });
    const advanced = await issues.get('project-1', second.id);
    expect(advanced.ok && advanced.value).toMatchObject({
      status: 'in_progress',
      attemptCount: 1,
    });
  });

  it('leaves an Issue with an existing run to the retry and CI paths', async () => {
    const { manager, issues } = await harness();
    const issue = await readyIssue(issues);
    const review = await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });
    if (!review.ok) throw new Error('spawn failed');

    const summary = await manager.autoDispatch();

    expect(summary.ok && summary.value.scheduled).toBe(0);
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value).toHaveLength(1);
    expect(runs.ok && runs.value[0]?.kind).toBe('review');
  });

  it('skips Issues on a cycle, with a broken dependency, or outside the ready label', async () => {
    const { manager, issues } = await harness();
    await readyIssue(issues, { title: 'A', githubNumber: 1, dependsOn: ['B'] });
    await readyIssue(issues, { title: 'B', githubNumber: 2, dependsOn: ['A'] });
    await readyIssue(issues, { title: 'Missing', githubNumber: 3, dependsOn: ['Nope'] });
    await readyIssue(issues, { title: 'Human', githubNumber: 4, label: 'needs-human' });
    const unsynced = await issues.create({ projectId: 'project-1', title: 'Unsynced' });
    expect(unsynced.ok).toBe(true);

    const summary = await manager.autoDispatch();

    expect(summary.ok && summary.value.scheduled).toBe(0);
  });

  it('waits for a free slot before starting the rest of the wave', async () => {
    const { manager, issues, k8s } = await harness({ maxPerProject: 2 });
    const first = await readyIssue(issues, { title: 'First', githubNumber: 1 });
    await readyIssue(issues, { title: 'Second', githubNumber: 2 });
    const third = await readyIssue(issues, { title: 'Third', githubNumber: 3 });

    const firstPass = await manager.autoDispatch();

    expect(firstPass.ok && firstPass.value.scheduled).toBe(2);
    const waiting = await manager.runs('project-1', third.id);
    expect(waiting.ok && waiting.value).toHaveLength(0);
    const waitingIssue = await issues.get('project-1', third.id);
    expect(waitingIssue.ok && waitingIssue.value.attemptCount).toBe(0);

    const firstRuns = await manager.runs('project-1', first.id);
    if (!firstRuns.ok || firstRuns.value[0]?.jobName == null) throw new Error('no run');
    await finishJob(k8s, NS, firstRuns.value[0].jobName, 'succeeded');
    await manager.reconcile();
    const secondPass = await manager.autoDispatch();

    expect(secondPass.ok && secondPass.value.scheduled).toBe(1);
    const started = await manager.runs('project-1', third.id);
    expect(started.ok && started.value[0]?.status).toBe('running');
  });

  it('backs off after a failed dispatch instead of retrying every pass', async () => {
    let mints = 0;
    const { manager, issues } = await harness({
      mintOpenrouterKey: async () => {
        mints += 1;
        return { ok: false, message: 'No credits' };
      },
    });
    await readyIssue(issues);

    const first = await manager.autoDispatch();
    const second = await manager.autoDispatch();

    expect(first.ok && first.value.scheduled).toBe(0);
    expect(second.ok && second.value.scheduled).toBe(0);
    expect(mints).toBe(1);
  });

  it('labels an Issue needs-human once when its budget cannot cover another reply', async () => {
    let mints = 0;
    const { manager, issues } = await harness({
      mintOpenrouterKey: async () => {
        mints += 1;
        return {
          ok: false,
          reason: 'reply-reservation',
          message:
            '$0.10 remains of Issue issue-1’s $2.00 budget after $1.90 spent, but the model can reserve up to $0.96 for one reply. Raise the Issue’s budget to at least $2.86 or choose a cheaper model.',
        };
      },
    });
    const issue = await readyIssue(issues);

    const first = await manager.autoDispatch();
    const second = await manager.autoDispatch();

    expect(first.ok && first.value.scheduled).toBe(0);
    expect(second.ok && second.value.scheduled).toBe(0);
    // The refusal is not retried on every pass: the label takes it out of the
    // dispatchable set, and the attempt counter is left alone.
    expect(mints).toBe(1);
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({
      label: 'needs-human',
      status: 'open',
      attemptCount: 0,
    });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value).toHaveLength(0);
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

  it('does not retry an attempt for an Issue whose pull request already merged', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);
    const spawned = await manager.spawn('project-1', issue.id);
    if (!spawned.ok) throw new Error('spawn failed');

    // The CI tracker closes the Issue when it merges the pull request.
    await issues.update('project-1', issue.id, {
      status: 'closed',
      closedAt: NOW.toISOString(),
    });
    await finishJob(k8s, NS, spawned.value.jobName!, 'failed');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({ failed: 1, dispatched: 0 });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value.map((run) => run.status)).toEqual(['failed']);
  });

  it('continues the same pull request branch when retrying a failed attempt', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues, { maxAttempts: 3 });
    const first = await manager.spawn('project-1', issue.id, {
      branch: 'agent/issue-42',
      reviewFeedback: 'Return JSON 404 for /api/* paths.',
    });
    if (!first.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, first.value.jobName!, 'failed');
    await manager.reconcile();

    const runs = await manager.runs('project-1', issue.id);
    if (!runs.ok) throw new Error('runs failed');
    const retry = runs.value.find((run) => run.attemptNumber === 2);
    if (retry?.jobName === null || retry?.jobName === undefined) throw new Error('no retry');
    const { container } = await readJobContainer(k8s, NS, retry.jobName);

    // A bare retry would clone main and implement the Issue again from scratch.
    expect(container.env).toContainEqual({ name: 'BRANCH', value: 'agent/issue-42' });
    expect(container.env).toContainEqual({
      name: 'REVIEW_FEEDBACK',
      value: 'Return JSON 404 for /api/* paths.',
    });
  });

  it('escalates a failed attempt whose retry cannot be afforded, instead of retrying forever', async () => {
    let mints = 0;
    const { manager, issues, k8s } = await harness({
      mintOpenrouterKey: async (_issue, attempt) => {
        mints += 1;
        if (attempt === 1) return { ok: true, key: 'sk-first', hash: 'hash-first' };
        return {
          ok: false,
          reason: 'reply-reservation',
          message:
            '$0.10 remains of Issue issue-1’s $1.00 budget after $0.90 spent. Raise the Issue’s budget or choose a cheaper model.',
        };
      },
    });
    const issue = await readyIssue(issues);
    const first = await manager.spawn('project-1', issue.id);
    if (!first.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, first.value.jobName!, 'failed');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({ failed: 1, escalated: 1, dispatched: 0 });
    expect(mints).toBe(2);
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ label: 'needs-human', status: 'open' });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value).toHaveLength(1);
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

/** Reads a byte stream to text. */
async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

describe('logs', () => {
  /** The Pod a Job creates; `backoffLimit` is 0, so there is only ever one. */
  const POD = 'agent-issue-1-attempt-1-abcde';

  /** A Pod the kubelet killed for exceeding its memory limit. */
  function oomPod(): K8sObject {
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: POD,
        namespace: NS,
        labels: { 'job-name': 'agent-issue-1-attempt-1' },
      },
      status: {
        phase: 'Failed',
        containerStatuses: [{ state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }],
      },
    };
  }

  it('captures the cause and last output of a run killed before it could report', async () => {
    const h = await harness({
      seed: [oomPod()],
      logs: { [`${NS}/${POD}`]: 'cloning repo\nrunning OpenCode\n' },
    });
    const issue = await readyIssue(h.issues);
    const spawned = await h.manager.spawn('project-1', issue.id);
    if (!spawned.ok) throw new Error('spawn failed');

    await finishJob(h.k8s, NS, spawned.value.jobName ?? '', 'failed');
    await h.manager.reconcile();

    const runs = await h.manager.runs('project-1', issue.id);
    if (!runs.ok) throw new Error('runs failed');
    const run = runs.value[0];
    expect(run).toMatchObject({ status: 'failed' });
    expect(run?.logs).toContain(
      'Pod agent-issue-1-attempt-1-abcde terminated: OOMKilled (exit code 137)',
    );
    expect(run?.logs).toContain('running OpenCode');
  });

  it('keeps the logs a run reported when the Pod also has output', async () => {
    const h = await harness({
      seed: [oomPod()],
      logs: { [`${NS}/${POD}`]: 'cloning repo\n' },
    });
    const issue = await readyIssue(h.issues);
    const spawned = await h.manager.spawn('project-1', issue.id);
    if (!spawned.ok) throw new Error('spawn failed');

    const { container } = await readJobContainer(h.k8s, NS, spawned.value.jobName ?? '');
    const token = container.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    if (token === undefined) throw new Error('run token missing');
    const reported = await h.manager.report(spawned.value.id, token, {
      logs: 'Error: Model unavailable: openrouter/chosen',
    });
    if (!reported.ok) throw new Error(`report failed: ${reported.error.message}`);

    await finishJob(h.k8s, NS, spawned.value.jobName ?? '', 'failed');
    await h.manager.reconcile();

    const runs = await h.manager.runs('project-1', issue.id);
    if (!runs.ok) throw new Error('runs failed');
    expect(runs.value[0]?.logs).toBe('Error: Model unavailable: openrouter/chosen');
  });

  it('streams a running attempt’s Pod output and returns a finished run’s stored log', async () => {
    const h = await harness({
      seed: [oomPod()],
      logs: { [`${NS}/${POD}`]: 'cloning repo\nrunning OpenCode\n' },
    });
    const issue = await readyIssue(h.issues);
    const spawned = await h.manager.spawn('project-1', issue.id);
    if (!spawned.ok) throw new Error('spawn failed');

    const live = await h.manager.logs(spawned.value.id, { follow: true });
    if (!live.ok) throw new Error(`logs failed: ${live.error.message}`);
    await expect(streamText(live.value)).resolves.toBe('cloning repo\nrunning OpenCode\n');

    await finishJob(h.k8s, NS, spawned.value.jobName ?? '', 'failed');
    await h.manager.reconcile();

    const stored = await h.manager.logs(spawned.value.id);
    if (!stored.ok) throw new Error(`logs failed: ${stored.error.message}`);
    await expect(streamText(stored.value)).resolves.toContain('OOMKilled');
  });

  it('reports an unknown run as not-found', async () => {
    const h = await harness();

    const result = await h.manager.logs('run-missing');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('not-found');
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
    const tokens = {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 300, write: 10 },
    };
    const reported = await manager.report(spawned.value.id, token!, {
      prUrl,
      costCents: 123,
      tokens,
    });

    expect(reported.ok && reported.value).toMatchObject({ prUrl, costCents: 123, tokens });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value[0]).toMatchObject({ prUrl, costCents: 123, tokens });
  });

  it('records the verdict and body a review reported', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);
    const spawned = await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    const { container } = await readJobContainer(k8s, NS, spawned.value.jobName!);
    const token = container.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    if (token === undefined) throw new Error('run token missing');

    const reported = await manager.report(spawned.value.id, token, {
      prUrl: 'https://github.com/acme/todo-app/pull/7',
      logs: 'Reviewed the diff.',
      reviewVerdict: 'request-changes',
      reviewBody: 'Return JSON 404 for /api/* paths.',
    });
    if (!reported.ok) throw new Error(`report failed: ${reported.error.message}`);

    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value[0]).toMatchObject({
      reviewVerdict: 'request-changes',
      reviewBody: 'Return JSON 404 for /api/* paths.',
    });
  });
});

describe('review runs', () => {
  it('dispatches a review run without consuming an implement attempt', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: 'review',
      pullNumber: 7,
      attemptNumber: 1,
      status: 'running',
      jobName: 'agent-review-issue-1-1',
      pvcName: 'agent-review-work-issue-1-1',
    });

    // Reviewing a pull request must never spend the Issue's implement budget.
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ attemptCount: 0 });

    const { spec, container } = await readJobContainer(k8s, NS, 'agent-review-issue-1-1');
    expect(container.env).toContainEqual({ name: 'AGENT_RUN_KIND', value: 'review' });
    expect(container.env).toContainEqual({ name: 'PULL_NUMBER', value: '7' });
    expect(container.env).toContainEqual({ name: 'BRANCH', value: 'agent/issue-42' });
    expect(container.env).toContainEqual({
      name: 'OPENCODE_CONFIG',
      value: AGENT_OPENCODE_CONFIG_PATH,
    });
    expect(spec.template.spec.serviceAccountName).toBe('yaaabk-agent');
  });

  it('mints a per-attempt key for a review run', async () => {
    let mints = 0;
    const { manager, issues } = await harness({
      mintOpenrouterKey: async () => {
        mints += 1;
        return { ok: true, key: `sk-review-${mints}`, hash: `hash-review-${mints}` };
      },
    });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });

    expect(result.ok).toBe(true);
    expect(mints).toBe(1);
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value.openrouterKeyHash).toBe('hash-review-1');
  });

  it('dispatches a conflict-resolution run without consuming an implement attempt', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, {
      kind: 'resolve-conflicts',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: 'resolve-conflicts',
      pullNumber: 7,
      attemptNumber: 1,
      status: 'running',
      jobName: 'agent-resolve-issue-1-1',
      pvcName: 'agent-resolve-work-issue-1-1',
    });

    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ attemptCount: 0 });

    const { container } = await readJobContainer(k8s, NS, 'agent-resolve-issue-1-1');
    expect(container.env).toContainEqual({ name: 'AGENT_RUN_KIND', value: 'resolve-conflicts' });
    expect(container.env).toContainEqual({ name: 'PULL_NUMBER', value: '7' });
    expect(container.env).toContainEqual({ name: 'BRANCH', value: 'agent/issue-42' });
    expect(container.env).toContainEqual({
      name: 'OPENCODE_CONFIG',
      value: AGENT_OPENCODE_CONFIG_PATH,
    });
  });

  it('does not retry a failed conflict-resolution run or change the Issue', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);
    const spawned = await manager.spawn('project-1', issue.id, {
      kind: 'resolve-conflicts',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, spawned.value.jobName!, 'failed');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({ failed: 1, dispatched: 0 });
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ status: 'open', attemptCount: 0 });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value.map((run) => run.status)).toEqual(['failed']);
  });

  it('refuses a conflict-resolution run without a pull request or branch', async () => {
    const { manager, issues } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, { kind: 'resolve-conflicts' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('mints a token scoped to the run kind', async () => {
    const { manager, issues, k8s, scopes } = await harness({
      githubToken: (scope) => Promise.resolve(scope === 'review' ? 'ghs-review' : 'ghs-implement'),
    });
    const issue = await readyIssue(issues);

    await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });

    expect(scopes).toEqual(['review']);
    const secret = await k8s.secrets.get(NS, 'agent-review-github-issue-1-1');
    expect(secret.ok && secret.value.keys).toEqual(['GITHUB_TOKEN']);
  });

  it('refuses a review run that does not say which pull request to judge', async () => {
    const { manager, issues } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, { kind: 'review' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('records the LLM spend a review run reports', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues);

    const spawned = await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    const { container } = await readJobContainer(k8s, NS, spawned.value.jobName!);
    const token = container.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    expect(token).toBeDefined();

    const reported = await manager.report(spawned.value.id, token!, {
      prUrl: 'https://github.com/acme/todo-app/pull/7',
      costCents: 10,
    });

    expect(reported.ok && reported.value).toMatchObject({ costCents: 10, kind: 'review' });
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value[0]).toMatchObject({ costCents: 10, kind: 'review' });
  });

  it('retries a failed review without escalating the Issue', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues, { maxAttempts: 2 });

    const first = await manager.spawn('project-1', issue.id, {
      kind: 'review',
      pullNumber: 7,
      branch: 'agent/issue-42',
    });
    if (!first.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, first.value.jobName!, 'failed');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({
      failed: 1,
      dispatched: 1,
      escalated: 0,
    });
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ attemptCount: 0 });
    expect(stored.ok && stored.value.label).not.toBe('needs-human');
  });
});

describe('deploy runs', () => {
  it('dispatches a deploy run as yaaabk-deploy with an ephemeral emptyDir volume and contents:read token scope', async () => {
    const { manager, issues, k8s, scopes } = await harness({
      githubToken: (scope) =>
        Promise.resolve(scope === 'deploy' ? 'ghs-deploy-readonly' : 'ghs-other'),
    });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, {
      kind: 'deploy',
      commitSha: 'sha-merged-7',
      branch: 'main',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: 'deploy',
      commitSha: 'sha-merged-7',
      attemptNumber: 1,
      status: 'running',
      jobName: 'yaaabk-deploy-issue-1-attempt-1',
      pvcName: null,
      model: null,
    });
    expect(scopes).toEqual(['deploy']);

    // No PVC should be created for a deploy run.
    expect((await k8s.pvcs.get(NS, 'yaaabk-deploy-work-issue-1-1')).ok).toBe(false);

    const secret = await k8s.secrets.get(NS, 'yaaabk-deploy-github-issue-1-1');
    expect(secret.ok && secret.value.keys).toEqual(['GITHUB_TOKEN']);

    const { spec, container } = await readJobContainer(k8s, NS, 'yaaabk-deploy-issue-1-attempt-1');
    expect(spec.template.spec.serviceAccountName).toBe('yaaabk-deploy');
    expect(container.env).toContainEqual({ name: 'AGENT_RUN_KIND', value: 'deploy' });
    expect(container.env).toContainEqual({ name: 'COMMIT_SHA', value: 'sha-merged-7' });
    expect(container.env).toContainEqual({ name: 'DEPLOY_NAMESPACE', value: NS });
    expect(container.env).toContainEqual({ name: 'DEPLOY_PATH', value: 'deploy' });
    expect(container.env).toContainEqual({ name: 'DEPLOYMENT_NAME', value: 'todo-app' });
    expect(container.env).not.toContainEqual(expect.objectContaining({ name: 'AGENT_MODEL' }));
    expect(container.env).not.toContainEqual(expect.objectContaining({ name: 'OPENCODE_CONFIG' }));
    expect(container.envFrom).toEqual([{ secretRef: { name: 'yaaabk-deploy-github-issue-1-1' } }]);

    // Does not consume an implement attempt or reopen the Issue.
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ attemptCount: 0, status: 'open' });
  });

  it('does not mint an OpenRouter key for a deploy run', async () => {
    let mints = 0;
    const { manager, issues, k8s } = await harness({
      mintOpenrouterKey: async () => {
        mints += 1;
        return { ok: true, key: 'sk-unused', hash: 'hash-unused' };
      },
    });
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, {
      kind: 'deploy',
      commitSha: 'sha-merged-7',
      branch: 'main',
    });

    expect(result.ok).toBe(true);
    expect(mints).toBe(0);
    expect((await k8s.secrets.get(NS, 'agent-openrouter-issue-1-1')).ok).toBe(false);
    const { container } = await readJobContainer(k8s, NS, 'yaaabk-deploy-issue-1-attempt-1');
    expect(container.envFrom).not.toContainEqual(
      expect.objectContaining({
        secretRef: expect.objectContaining({ name: 'agent-openrouter-issue-1-1' }),
      }),
    );
  });

  it('refuses a deploy run without a commit SHA', async () => {
    const { manager, issues } = await harness();
    const issue = await readyIssue(issues);

    const result = await manager.spawn('project-1', issue.id, { kind: 'deploy' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('records the deployed commit SHA and last deploy status on the Project when the deploy Job reports success', async () => {
    const { manager, issues, k8s, projects } = await harness();
    const issue = await readyIssue(issues);
    const spawned = await manager.spawn('project-1', issue.id, {
      kind: 'deploy',
      commitSha: 'sha-merged-7',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    const { container } = await readJobContainer(k8s, NS, spawned.value.jobName!);
    const token = container.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    expect(token).toBeDefined();

    const reported = await manager.report(spawned.value.id, token!, {
      logs: 'deployed sha-merged-7',
      commitSha: 'sha-merged-7',
      deployOutcome: 'success',
    });

    expect(reported.ok && reported.value).toMatchObject({
      kind: 'deploy',
      commitSha: 'sha-merged-7',
    });
    expect(projects.get('project-1')).toMatchObject({
      deployedCommitSha: 'sha-merged-7',
      lastDeployStatus: 'success',
      lastDeployAt: NOW.toISOString(),
    });
  });

  it('records a failed deploy without advancing the deployed SHA or reopening the Issue', async () => {
    const { manager, issues, k8s, projects, github } = await harness();
    const created = await github.createIssue('acme/todo-app', {
      title: 'Add login',
      body: '',
      labels: ['ready'],
    });
    if (!created.ok) throw new Error('github issue create failed');
    const issue = await readyIssue(issues, { githubNumber: created.value.number, maxAttempts: 2 });
    const spawned = await manager.spawn('project-1', issue.id, {
      kind: 'deploy',
      commitSha: 'sha-merged-7',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    const { container } = await readJobContainer(k8s, NS, spawned.value.jobName!);
    const token = container.env?.find((entry) => entry.name === 'AGENT_RUN_TOKEN')?.value;
    expect(token).toBeDefined();

    const reported = await manager.report(spawned.value.id, token!, {
      logs: 'rollout failed\nPod logs:\nError: CrashLoopBackOff',
      commitSha: 'sha-merged-7',
      deployOutcome: 'failed',
    });

    expect(reported.ok).toBe(true);
    // The failed SHA never becomes the deployed one: the previous revision is
    // what stayed live after the rollback.
    expect(projects.get('project-1')).toMatchObject({
      deployedCommitSha: null,
      lastDeployStatus: 'failed',
      lastDeployAt: NOW.toISOString(),
    });
    // The Issue stays closed/open as it was; only a label is added on GitHub.
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ attemptCount: 0, label: 'ready' });
    expect(github.issues('acme/todo-app')[0]?.labels).toContain('deploy-failed');
    expect(github.labels('acme/todo-app')).toContain('deploy-failed');
  });

  it('does not spawn a fix Agent or reopen the Issue after a failed deploy', async () => {
    const { manager, issues, k8s } = await harness();
    const issue = await readyIssue(issues, { maxAttempts: 2 });

    const spawned = await manager.spawn('project-1', issue.id, {
      kind: 'deploy',
      commitSha: 'sha-merged-7',
    });
    if (!spawned.ok) throw new Error('spawn failed');

    await finishJob(k8s, NS, spawned.value.jobName!, 'failed');
    const summary = await manager.reconcile();

    expect(summary.ok && summary.value).toMatchObject({
      failed: 1,
      dispatched: 0,
      escalated: 0,
    });
    const stored = await issues.get('project-1', issue.id);
    expect(stored.ok && stored.value).toMatchObject({ attemptCount: 0, status: 'open' });
    expect(stored.ok && stored.value.label).not.toBe('needs-human');
    const runs = await manager.runs('project-1', issue.id);
    expect(runs.ok && runs.value).toHaveLength(1);
  });
});
