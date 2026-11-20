import { expect, test, type Page } from '@playwright/test';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  mode: 'guided',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
  lastModel: null,
  agentModel: null,
  deployedCommitSha: null,
  lastDeployStatus: null,
  lastDeployAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ACTIVE_WORK = {
  id: 'r1',
  issueId: 'i1',
  issueTitle: 'Schema',
  kind: 'implement-issue',
  attemptNumber: 1,
  status: 'running',
  createdAt: '2026-02-01T00:00:00.000Z',
  startedAt: '2026-02-01T00:01:00.000Z',
};

const ISSUES = { total: 3, open: 1, inProgress: 0, closed: 2, failed: 0, averageAttempts: 1 };

/** A Project overview with no active plan and nothing in flight. */
const IDLE_OVERVIEW = {
  project: PROJECT,
  activePlan: null,
  activeWork: [],
  issues: ISSUES,
  lastRunAt: '2026-02-01T00:00:00.000Z',
};

/** A signed-in session. */
async function mockAuth(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
}

/** Answers the home page's single overview request. */
async function mockOverview(page: Page, overviews: unknown[] = [IDLE_OVERVIEW]): Promise<void> {
  await page.route('**/api/overview', (route) => route.fulfill({ json: { overviews } }));
}

/**
 * Navigates and waits until the client app has hydrated. The root layout
 * fetches `/api/auth/status` once running, so waiting for that response proves
 * the page handlers are attached; without it a click can land before hydration
 * and submit a form natively.
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

test('lists every project with its key metadata', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page);

  await gotoHydrated(page, '/');

  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  await expect(page.getByText('Guided')).toBeVisible();
  await expect(page.getByText('yaaabk-a1b2c3d4')).toBeVisible();
  await expect(page.getByText('1 open · 2 closed')).toBeVisible();
  await expect(page.getByText('2026-02-01', { exact: false })).toBeVisible();
  await expect(page.getByText('Idle')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Agent' })).toHaveAttribute(
    'href',
    '/projects/p1/plan',
  );
  await expect(page.getByRole('link', { name: 'Issue board' })).toHaveAttribute(
    'href',
    '/projects/p1/issues',
  );
  await expect(page.getByRole('link', { name: 'Stats' })).toHaveAttribute(
    'href',
    '/projects/p1/stats',
  );
});

test('flags an unaccepted active plan and reports running work', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page, [
    {
      ...IDLE_OVERVIEW,
      activePlan: { id: 'plan-1', version: 3, acceptedAt: null },
      activeWork: [ACTIVE_WORK],
    },
  ]);

  await gotoHydrated(page, '/');

  await expect(page.getByRole('link', { name: 'Plan v3 not accepted' })).toHaveAttribute(
    'href',
    '/projects/p1/issues/review',
  );
  await expect(page.getByText('Active · 1 running')).toBeVisible();
});

test('does not flag an accepted plan', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page, [
    {
      ...IDLE_OVERVIEW,
      activePlan: { id: 'plan-1', version: 3, acceptedAt: '2026-02-02T00:00:00.000Z' },
    },
  ]);

  await gotoHydrated(page, '/');

  await expect(page.getByRole('link', { name: /Plan v3/ })).toHaveCount(0);
  await expect(page.getByText('Idle')).toBeVisible();
});

test('invites the Developer to create the first project when there are none', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page, []);

  await gotoHydrated(page, '/');

  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first project' })).toBeVisible();
});

test('surfaces a failure state', async ({ page }) => {
  await mockAuth(page);
  await page.route('**/api/overview', (route) =>
    route.fulfill({ status: 502, json: { error: 'kubernetes', message: 'cluster unreachable' } }),
  );

  await gotoHydrated(page, '/');

  await expect(page.getByRole('alert')).toHaveText('cluster unreachable');
});

test('opens a project dashboard from the list', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page);
  await page.route('**/api/projects/p1/overview', (route) =>
    route.fulfill({ json: IDLE_OVERVIEW }),
  );
  await page.route('**/api/models', (route) => route.fulfill({ json: { models: [] } }));

  await gotoHydrated(page, '/');
  await page.getByRole('link', { name: 'todo-app' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
});
