import { describe, expect, it } from 'vitest';
import {
  createAgentManager,
  createInMemoryAgentStore,
  silentLogger as agentsLogger,
  type AgentManager,
} from '@yaaabk/agents';
import {
  createFakeGitHubIssues,
  createFakeGitHubPulls,
  type FakeGitHubIssues,
  type FakeGitHubPulls,
} from '@yaaabk/github';
import { createInMemoryIssueStore, createIssuesModule, type IssuesModule } from '@yaaabk/issues';
import { createMockK8sClient } from '@yaaabk/k8s';
import { createInMemoryProjectStore, type Project } from '@yaaabk/projects';
import { createCiTracker, type CiTrackerOptions } from './ci-tracker';
import { DEFAULT_POLL_INTERVAL_MS } from './config';
import { silentLogger } from './errors';
import type { CiTracker, CiTimers } from './types';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const REPO = 'acme/todo-app';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'todo-app',
    description: 'A todo app',
    skillLevel: 'expert',
    repoUrl: `https://github.com/${REPO}`,
    repoFullName: REPO,
    namespace: 'project-a1b2c3d4',
    argoAppName: 'todo-app',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** A scheduler that records the interval and lets a test fire it by hand. */
function fakeTimers() {
  let handler: (() => void) | null = null;
  let interval: number | null = null;
  let clears = 0;
  return {
    timers: {
      setInterval: (next: () => void, ms: number) => {
        handler = next;
        interval = ms;
        return 1;
      },
      clearInterval: () => {
        handler = null;
        clears += 1;
      },
    } satisfies CiTimers,
    fire: async () => {
      handler?.();
      // Let the tracker's fire-and-forget poll settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    get interval() {
      return interval;
    },
    get running() {
      return handler !== null;
    },
    get clears() {
      return clears;
    },
  };
}

interface HarnessOptions {
  maxAttempts?: number;
  attemptCount?: number;
  enabled?: boolean;
  timers?: CiTimers;
}

interface Harness {
  tracker: CiTracker;
  issues: IssuesModule;
  agents: AgentManager;
  pulls: FakeGitHubPulls;
  githubIssues: FakeGitHubIssues;
  projectId: string;
  issueId: string;
  githubNumber: number;
  branch: string;
}

/**
 * Builds a tracker over a real Issues Module and Agent Manager, an in-memory
 * Project store, and fakes for the two GitHub ports.
 */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const projectId = 'project-1';
  const projectStore = createInMemoryProjectStore();
  projectStore.create(project());

  let issueSequence = 0;
  const issues = createIssuesModule({
    store: createInMemoryIssueStore(),
    clock: () => NOW,
    ids: () => `issue-${++issueSequence}`,
    logger: silentLogger,
  });

  const githubIssues = createFakeGitHubIssues();
  const opened = await githubIssues.createIssue(REPO, {
    title: 'Add login',
    body: '',
    labels: ['ready'],
  });
  if (!opened.ok) throw new Error('github issue setup failed');

  const created = await issues.create({
    projectId,
    title: 'Add login',
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  if (!created.ok) throw new Error(`issue create failed: ${created.error.message}`);
  const synced = await issues.update(projectId, created.value.id, {
    githubNumber: opened.value.number,
    ...(options.attemptCount === undefined ? {} : { attemptCount: options.attemptCount }),
  });
  if (!synced.ok) throw new Error(`issue update failed: ${synced.error.message}`);

  const agents = createAgentManager({
    store: createInMemoryAgentStore(),
    issues,
    projects: projectStore,
    k8s: createMockK8sClient(),
    clock: () => NOW,
    logger: agentsLogger,
  });

  const pulls = createFakeGitHubPulls();
  const trackerOptions: CiTrackerOptions = {
    projects: projectStore,
    issues,
    agents,
    pulls,
    githubIssues,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    clock: () => NOW,
    logger: silentLogger,
  };
  const tracker = createCiTracker(trackerOptions);

  return {
    tracker,
    issues,
    agents,
    pulls,
    githubIssues,
    projectId,
    issueId: created.value.id,
    githubNumber: opened.value.number,
    branch: `agent/issue-${opened.value.number}`,
  };
}

/** Seeds an `automerge` pull request for the harness's Issue. */
function watch(
  h: Harness,
  options: { headSha?: string; state?: 'pending' | 'success' | 'failure'; draft?: boolean } = {},
) {
  const headSha = options.headSha ?? 'sha-7';
  h.pulls.addPullRequest(REPO, {
    number: 7,
    headRef: h.branch,
    headSha,
    labels: ['automerge'],
    ...(options.draft === undefined ? {} : { draft: options.draft }),
  });
  h.pulls.setChecks(REPO, headSha, {
    state: options.state ?? 'success',
    failed: options.state === 'failure' ? ['test'] : [],
    total: 1,
  });
}

describe('poll', () => {
  it('merges a passing pull request and closes its Issue locally and on GitHub', async () => {
    const h = await harness();
    watch(h);

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { pulls: 1, merged: 1 } });
    expect(h.pulls.merged(REPO, 7)).toBe(true);
    const issue = await h.issues.get(h.projectId, h.issueId);
    expect(issue.ok && issue.value).toMatchObject({ status: 'closed' });
    expect(h.githubIssues.issues(REPO).find((i) => i.number === h.githubNumber)?.state).toBe(
      'closed',
    );
  });

  it('spawns a fix attempt on the pull request branch when checks fail', async () => {
    const h = await harness();
    watch(h, { state: 'failure' });

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { fixSpawned: 1, merged: 0 } });
    const runs = await h.agents.runs(h.projectId, h.issueId);
    expect(runs.ok && runs.value).toHaveLength(1);
    expect(runs.ok && runs.value[0]).toMatchObject({ branch: h.branch, attemptNumber: 1 });
  });

  it('labels an Issue needs-human instead of retrying once its attempts are spent', async () => {
    const h = await harness({ maxAttempts: 3, attemptCount: 3 });
    watch(h, { state: 'failure' });

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { needsHuman: 1, fixSpawned: 0 } });
    const issue = await h.issues.get(h.projectId, h.issueId);
    expect(issue.ok && issue.value.label).toBe('needs-human');
    const runs = await h.agents.runs(h.projectId, h.issueId);
    expect(runs.ok && runs.value).toHaveLength(0);
  });

  it('spawns only one fix attempt for a still-failing head commit', async () => {
    const h = await harness();
    watch(h, { state: 'failure' });

    await h.tracker.poll();
    await h.tracker.poll();

    const runs = await h.agents.runs(h.projectId, h.issueId);
    expect(runs.ok && runs.value).toHaveLength(1);
  });

  it('waits while checks are still running', async () => {
    const h = await harness();
    watch(h, { state: 'pending' });

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { pending: 1, merged: 0, fixSpawned: 0 } });
    expect(h.pulls.merged(REPO, 7)).toBe(false);
  });

  it('leaves a draft pull request alone', async () => {
    const h = await harness();
    watch(h, { draft: true });

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { merged: 0, fixSpawned: 0 } });
    expect(h.pulls.merged(REPO, 7)).toBe(false);
  });

  it('ignores a pull request that does not implement an Issue branch', async () => {
    const h = await harness();
    h.pulls.addPullRequest(REPO, {
      number: 7,
      headRef: 'feature/not-an-agent',
      headSha: 'sha-7',
      labels: ['automerge'],
    });
    h.pulls.setChecks(REPO, 'sha-7', { state: 'success', total: 1 });

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { merged: 0, fixSpawned: 0 } });
  });

  it('does nothing while disabled', async () => {
    const h = await harness({ enabled: false });
    watch(h);

    const result = await h.tracker.poll();

    expect(result).toMatchObject({ ok: true, value: { projects: 0, merged: 0 } });
    expect(h.pulls.merged(REPO, 7)).toBe(false);
  });
});

describe('status', () => {
  it('reports the watches it has seen and when it last checked', async () => {
    const h = await harness();
    watch(h);

    await h.tracker.poll();

    const status = h.tracker.status();
    expect(status.lastCheckedAt).toBe(NOW.toISOString());
    expect(status.watches).toHaveLength(1);
    expect(status.watches[0]).toMatchObject({
      pullNumber: 7,
      headRef: h.branch,
      state: 'success',
      action: 'merged',
      issueId: h.issueId,
    });
  });
});

describe('configure', () => {
  it('rejects an interval outside the accepted range', async () => {
    const h = await harness();

    const result = h.tracker.configure({ intervalMs: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('updates the interval and the enabled flag', async () => {
    const h = await harness();

    const result = h.tracker.configure({ enabled: false, intervalMs: 60_000 });

    expect(result).toMatchObject({ ok: true, value: { enabled: false, intervalMs: 60_000 } });
  });
});

describe('start and stop', () => {
  it('schedules polling at the configured interval and stops when told', async () => {
    const ft = fakeTimers();
    const h = await harness({ timers: ft.timers });

    h.tracker.start();
    expect(ft.running).toBe(true);
    expect(ft.interval).toBe(DEFAULT_POLL_INTERVAL_MS);

    h.tracker.configure({ intervalMs: 60_000 });
    expect(ft.interval).toBe(60_000);

    h.tracker.stop();
    expect(ft.running).toBe(false);
  });

  it('does not schedule while disabled', async () => {
    const ft = fakeTimers();
    const h = await harness({ enabled: false, timers: ft.timers });

    h.tracker.start();

    expect(ft.running).toBe(false);
  });

  it('polls when the interval fires', async () => {
    const ft = fakeTimers();
    const h = await harness({ timers: ft.timers });
    watch(h);

    h.tracker.start();
    await ft.fire();

    expect(h.pulls.merged(REPO, 7)).toBe(true);
  });
});
