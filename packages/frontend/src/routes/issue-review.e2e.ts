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

const PLAN = {
  id: 'v1',
  projectId: 'p1',
  version: 1,
  contentMarkdown: '# Plan',
  skillLevel: 'expert',
  source: 'grill-me',
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
};

function issue(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'i1',
    projectId: 'p1',
    planId: 'v1',
    githubNumber: null,
    body: '',
    status: 'open',
    label: 'refinement-needed',
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

const SCHEMA = issue({ id: 'i1', title: 'Schema', label: 'ready', body: 'Create the tables' });
const API = issue({
  id: 'i2',
  title: 'Api',
  label: 'refinement-needed',
  dependsOn: ['Schema'],
  createdAt: '2026-01-02T00:00:00.000Z',
});

const GRAPH: IssueGraph = {
  nodes: [
    { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: 0 },
    { id: 'i2', title: 'Api', dependsOn: ['i1'], missing: [], wave: 1 },
  ],
  cycles: [],
};

interface Mocks {
  issues: Record<string, unknown>[];
  graph: IssueGraph;
}

/** Mocks the project, its active plan and the issue endpoints. */
async function mockReview(page: Page): Promise<Mocks> {
  const state: Mocks = { issues: [SCHEMA, API], graph: GRAPH };

  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects/p1/plans/active', (route) => route.fulfill({ json: PLAN }));
  await page.route('**/api/projects/p1/issues', (route) =>
    route.fulfill({ json: { issues: state.issues } }),
  );
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: state.graph }),
  );
  return state;
}

test('shows the plan, issues grouped by wave, and their labels', async ({ page }) => {
  await mockReview(page);

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('heading', { name: 'Active plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wave 0' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wave 1' })).toBeVisible();
  await expect(page.getByText('Create the tables')).toBeVisible();
  await expect(page.getByText('refinement-needed')).toBeVisible();
  await expect(page.getByText('Depends on: Schema')).toBeVisible();
});

test('warns about circular dependencies', async ({ page }) => {
  const state = await mockReview(page);
  state.graph = {
    nodes: [
      { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: null },
      { id: 'i2', title: 'Api', dependsOn: [], missing: [], wave: null },
    ],
    cycles: [['i1', 'i2']],
  };

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('heading', { name: 'Circular dependencies' })).toBeVisible();
  await expect(page.getByText('i1 → i2 → i1')).toBeVisible();
});

test('refines the issue list with a prompt', async ({ page }) => {
  const state = await mockReview(page);
  const REVISED = issue({ id: 'i3', title: 'Add OAuth', label: 'ready' });
  await page.route('**/api/projects/p1/issues/refine', (route) => {
    state.issues = [REVISED];
    state.graph = {
      nodes: [{ id: 'i3', title: 'Add OAuth', dependsOn: [], missing: [], wave: 0 }],
      cycles: [],
    };
    return route.fulfill({ json: { issues: state.issues } });
  });

  await page.goto('/projects/p1/issues/review');
  await page.getByLabel('Refinement feedback').fill('Split the auth issue');
  await page.getByRole('button', { name: 'Refine' }).click();

  await expect(page.getByText('Add OAuth')).toBeVisible();
  await expect(page.getByText('Schema')).toBeHidden();
});

test('approves the issue list', async ({ page }) => {
  const state = await mockReview(page);
  await page.route('**/api/projects/p1/issues/approve', (route) => {
    state.issues = state.issues.map((item) => ({ ...item, label: 'ready' }));
    return route.fulfill({ json: { issues: state.issues } });
  });

  await page.goto('/projects/p1/issues/review');
  await page.getByRole('button', { name: 'Approve & Create' }).click();

  await expect(page.getByText('Issues approved and ready.')).toBeVisible();
});

test('offers to generate issues when there are none', async ({ page }) => {
  const state = await mockReview(page);
  state.issues = [];
  state.graph = { nodes: [], cycles: [] };

  await page.goto('/projects/p1/issues/review');
  await expect(page.getByText('No issues yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate from plan' })).toBeVisible();
});
