import {
  createInMemoryIssueStore,
  createIssuesModule,
  type Issue,
  type IssuesModule,
} from '@yaaabk/issues';
import { describe, expect, it } from 'vitest';
import { createFakeGitHubIssues, type FakeGitHubIssues } from './fake-github-issues';
import { createIssueSyncModule } from './issue-sync';
import { decodeIssueBody } from './metadata';

const NOW = Date.UTC(2026, 0, 1, 12);

interface Context {
  issues: IssuesModule;
  github: FakeGitHubIssues;
  sync: ReturnType<typeof createIssueSyncModule>;
  sleeps: number[];
}

function context(): Context {
  let sequence = 0;
  const issues = createIssuesModule({
    store: createInMemoryIssueStore(),
    ids: () => `issue-${String((sequence += 1)).padStart(3, '0')}`,
    clock: () => new Date(NOW),
    logger: { info: () => {}, error: () => {} },
  });
  const github = createFakeGitHubIssues();
  const sleeps: number[] = [];
  const sync = createIssueSyncModule({
    issues,
    github,
    clock: () => new Date(NOW),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: { info: () => {}, error: () => {} },
  });
  return { issues, github, sync, sleeps };
}

async function list(issues: IssuesModule): Promise<Issue[]> {
  const result = await issues.list('p1');
  if (!result.ok) throw new Error('list failed');
  return result.value;
}

async function seed(issues: IssuesModule): Promise<void> {
  await issues.create({
    projectId: 'p1',
    title: 'Schema',
    body: 'Define the tables.',
    budgetCents: 40,
  });
  await issues.create({
    projectId: 'p1',
    title: 'Add login',
    body: 'Build the form.',
    dependsOn: ['Schema'],
    budgetCents: 75,
  });
  await issues.approve('p1');
}

describe('issue sync push', () => {
  it('creates a GitHub issue per approved issue and records its number', async () => {
    const { issues, github, sync } = context();
    await seed(issues);

    const result = await sync.push('p1', 'acme/todo-app');

    expect(result.ok).toBe(true);
    const remote = github.issues('acme/todo-app');
    expect(remote.map((issue) => issue.title)).toEqual(['Schema', 'Add login']);
    expect(remote.every((issue) => issue.labels.includes('ready'))).toBe(true);

    const pushed = await list(issues);
    const login = pushed.find((issue) => issue.title === 'Add login');
    expect(login?.githubNumber).toBe(remote[1]?.number);
    expect(login?.githubSyncedAt).toBe(new Date(NOW).toISOString());
  });

  it('carries YAAABK-only metadata in the GitHub body', async () => {
    const { issues, github, sync } = context();
    await seed(issues);

    await sync.push('p1', 'acme/todo-app');

    const login = github.issues('acme/todo-app').find((issue) => issue.title === 'Add login');
    expect(decodeIssueBody(login?.body ?? '')).toEqual({
      body: 'Build the form.',
      metadata: { dependsOn: ['Schema'], budgetCents: 75 },
    });
  });

  it('updates an already-synced issue instead of creating a duplicate', async () => {
    const { issues, github, sync } = context();
    await seed(issues);
    await sync.push('p1', 'acme/todo-app');

    await issues.update('p1', (await list(issues))[1]!.id, { title: 'Add signup' });
    const result = await sync.push('p1', 'acme/todo-app');

    expect(result.ok).toBe(true);
    expect(github.issues('acme/todo-app').map((issue) => issue.title)).toEqual([
      'Schema',
      'Add signup',
    ]);
  });

  it('retries a rate-limited create and succeeds', async () => {
    const { issues, github, sync, sleeps } = context();
    await seed(issues);
    github.rateLimitNext('create-issue');

    const result = await sync.push('p1', 'acme/todo-app');

    expect(result.ok).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(github.issues('acme/todo-app')).toHaveLength(2);
  });

  it('reports a typed failure once a retryable failure exhausts its attempts', async () => {
    const { issues, github, sync, sleeps } = context();
    await seed(issues);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      github.rateLimitNext('create-issue');
    }

    const result = await sync.push('p1', 'acme/todo-app');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('github');
      expect(result.error.github?.kind).toBe('rate-limited');
    }
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry a failure a second attempt cannot fix', async () => {
    const { issues, github, sync, sleeps } = context();
    await seed(issues);
    github.failNext('create-issue', {
      kind: 'unauthorized',
      operation: 'create-issue',
      message: 'Bad credentials',
    });

    const result = await sync.push('p1', 'acme/todo-app');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.github?.kind).toBe('unauthorized');
    expect(sleeps).toHaveLength(0);
  });
});

describe('issue sync pull', () => {
  it('closes a local issue when GitHub closes it', async () => {
    const { issues, github, sync } = context();
    await seed(issues);
    await sync.push('p1', 'acme/todo-app');
    const login = github.issues('acme/todo-app').find((issue) => issue.title === 'Add login')!;
    github.setState('acme/todo-app', login.number, 'closed');

    const result = await sync.pull('p1', 'acme/todo-app');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changed).toBe(1);
    const listed = await list(issues);
    const closed = listed.find((issue) => issue.title === 'Add login');
    expect(closed?.status).toBe('closed');
    expect(closed?.closedAt).toBe(new Date(NOW).toISOString());
  });

  it('reopens a local issue when GitHub reopens it', async () => {
    const { issues, github, sync } = context();
    await seed(issues);
    await sync.push('p1', 'acme/todo-app');
    const login = github.issues('acme/todo-app').find((issue) => issue.title === 'Add login')!;
    github.setState('acme/todo-app', login.number, 'closed');
    await sync.pull('p1', 'acme/todo-app');

    github.setState('acme/todo-app', login.number, 'open');
    const result = await sync.pull('p1', 'acme/todo-app');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changed).toBe(1);
    const local = (await list(issues)).find((issue) => issue.title === 'Add login');
    expect(local?.status).toBe('open');
    expect(local?.closedAt).toBeNull();
  });

  it('keeps YAAABK-only metadata and local text through a round trip', async () => {
    const { issues, sync } = context();
    await seed(issues);
    await sync.push('p1', 'acme/todo-app');

    await sync.pull('p1', 'acme/todo-app');

    const local = (await list(issues)).find((issue) => issue.title === 'Add login');
    expect(local?.body).toBe('Build the form.');
    expect(local?.dependsOn).toEqual(['Schema']);
    expect(local?.budgetCents).toBe(75);
  });
});

describe('issue sync status', () => {
  it('reports what is mirrored and when it last synced', async () => {
    const { issues, sync } = context();
    await seed(issues);

    const before = await sync.status('p1');
    expect(before.ok && before.value).toEqual({
      total: 2,
      synced: 0,
      pending: 2,
      lastSyncedAt: null,
    });

    await sync.push('p1', 'acme/todo-app');

    const after = await sync.status('p1');
    expect(after.ok && after.value).toEqual({
      total: 2,
      synced: 2,
      pending: 0,
      lastSyncedAt: new Date(NOW).toISOString(),
    });
  });

  it('runs a full push-then-pull cycle', async () => {
    const { issues, github, sync } = context();
    await seed(issues);

    const result = await sync.sync('p1', 'acme/todo-app');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.push.created).toBe(2);
      expect(result.value.push.status.pending).toBe(0);
    }
    expect(github.issues('acme/todo-app')).toHaveLength(2);
  });
});
