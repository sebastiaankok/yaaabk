import { expect, test, type Page } from '@playwright/test';
import type { IssueGraph } from '@yaaabk/issues';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  skillLevel: 'expert',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'project-a1b2c3d4',
  argoAppName: 'todo-app',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function issue(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'i1',
    projectId: 'p1',
    planId: 'v1',
    githubNumber: null,
    githubSyncedAt: null,
    body: '',
    status: 'open',
    label: 'ready',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 50,
    openrouterKeyHash: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const READY = issue({ id: 'i1', title: 'Schema', label: 'ready', body: 'Create the tables' });
const BLOCKED = issue({ id: 'i2', title: 'Api', label: 'blocked', dependsOn: ['Schema'] });
const ACTIVE = issue({
  id: 'i3',
  title: 'Auth',
  status: 'in_progress',
  attemptCount: 1,
  createdAt: '2026-01-02T00:00:00.000Z',
});
const CLOSED = issue({
  id: 'i4',
  title: 'Scaffold',
  status: 'closed',
  createdAt: '2026-01-03T00:00:00.000Z',
});
const FAILED = issue({
  id: 'i5',
  title: 'Deploy',
  status: 'failed',
  label: 'needs-human',
  createdAt: '2026-01-04T00:00:00.000Z',
});

const GRAPH: IssueGraph = {
  nodes: [
    { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: 0 },
    { id: 'i2', title: 'Api', dependsOn: ['i1'], missing: [], wave: 1 },
    { id: 'i3', title: 'Auth', dependsOn: [], missing: [], wave: 0 },
    { id: 'i4', title: 'Scaffold', dependsOn: [], missing: [], wave: 0 },
    { id: 'i5', title: 'Deploy', dependsOn: ['i2'], missing: [], wave: 2 },
  ],
  cycles: [],
};

interface Mocks {
  issues: Record<string, unknown>[];
  graph: IssueGraph;
  runs: Record<string, unknown>[];
}

/** Mocks the project and the endpoints the board reads on load. */
async function mockBoard(page: Page): Promise<Mocks> {
  const state: Mocks = {
    issues: [READY, BLOCKED, ACTIVE, CLOSED, FAILED],
    graph: GRAPH,
    runs: [
      {
        id: 'r1',
        issueId: 'i1',
        attemptNumber: 1,
        status: 'success',
        prUrl: 'https://github.com/acme/todo-app/pull/1',
        costCents: 10,
        logs: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:05:00.000Z',
      },
    ],
  };

  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects/p1/issues', (route) =>
    route.fulfill({ json: { issues: state.issues } }),
  );
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: state.graph }),
  );
  await page.route('**/api/projects/p1/agent-runs', (route) =>
    route.fulfill({ json: { runs: state.runs } }),
  );
  return state;
}

/** The board card for an issue title, matched by the start of its accessible name. */
function card(page: Page, title: string) {
  return page.getByRole('button', { name: new RegExp(`^${title} `) });
}

test('groups issues into their lanes with labels and waves', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Blocked' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In Progress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Closed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Failed' })).toBeVisible();

  const ready = page.getByRole('region', { name: 'Ready' });
  await expect(ready.getByText('Schema')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Blocked' }).getByText('Api')).toBeVisible();
  await expect(page.getByRole('region', { name: 'In Progress' }).getByText('Auth')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Closed' }).getByText('Scaffold')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Failed' }).getByText('Deploy')).toBeVisible();
  await expect(ready.getByText('Wave 0')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Failed' }).getByText('Wave 2')).toBeVisible();
});

test('draws dependency arrows between cards', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await expect(page.locator('[data-edge="i1->i2"]')).toHaveCount(1);
  await expect(page.locator('[data-edge="i2->i5"]')).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Blocked' }).getByText('Depends on: Schema'),
  ).toBeVisible();
});

test('filters the cards by text, label, lane and wave', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await page.getByLabel('Search issues').fill('auth');
  await expect(card(page, 'Auth')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();

  await page.getByLabel('Search issues').fill('');
  await page.getByLabel('Filter by label').selectOption('blocked');
  await expect(card(page, 'Api')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();
  await page.getByLabel('Filter by label').selectOption('');

  await page.getByLabel('Filter by wave').selectOption('2');
  await expect(card(page, 'Deploy')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();
  await page.getByLabel('Filter by wave').selectOption('');

  await page.getByLabel('Filter by lane').selectOption('failed');
  await expect(card(page, 'Deploy')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();
});

test('opens a card to show its body and agent run history', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('Create the tables')).toBeVisible();
  await expect(panel.getByText('Attempt 1')).toBeVisible();
  await expect(panel.getByText('success')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'PR #1' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app/pull/1',
  );
});

test('re-runs an agent for the open issue', async ({ page }) => {
  const state = await mockBoard(page);
  await page.route('**/api/projects/p1/issues/i1/spawn', (route) => {
    const run = {
      id: 'r2',
      issueId: 'i1',
      attemptNumber: 2,
      status: 'queued',
      prUrl: null,
      costCents: 0,
      logs: null,
      startedAt: null,
      finishedAt: null,
    };
    state.runs = [...state.runs, run];
    return route.fulfill({ json: run, status: 202 });
  });

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();
  await page.getByRole('button', { name: 'Re-run' }).click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('Attempt 2')).toBeVisible();
  await expect(panel.getByText('queued')).toBeVisible();
});

test('edits and deletes the open issue', async ({ page }) => {
  const state = await mockBoard(page);
  await page.route('**/api/projects/p1/issues/i1', (route) => {
    if (route.request().method() === 'PATCH') {
      state.issues = state.issues.map((item) =>
        item.id === 'i1' ? { ...item, title: 'Schema v2' } : item,
      );
      return route.fulfill({ json: state.issues.find((item) => item.id === 'i1') });
    }
    if (route.request().method() === 'DELETE') {
      state.issues = state.issues.filter((item) => item.id !== 'i1');
      state.graph = { nodes: state.graph.nodes.filter((node) => node.id !== 'i1'), cycles: [] };
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Issue title').fill('Schema v2');
  await page.getByRole('button', { name: 'Save' }).click();

  const panel = page.getByRole('dialog', { name: 'Schema v2' });
  await expect(panel).toBeVisible();
  await expect(card(page, 'Schema v2')).toBeVisible();

  await panel.getByRole('button', { name: 'Delete' }).click();
  await panel.getByRole('button', { name: 'Confirm delete' }).click();

  await expect(panel).toBeHidden();
  await expect(card(page, 'Schema v2')).toBeHidden();
});
