import { expect, test, type Page } from '@playwright/test';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  skillLevel: 'expert',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
  deployedCommitSha: null,
  lastDeployStatus: null,
  lastDeployAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const STATS = {
  issues: { total: 5, open: 1, inProgress: 1, closed: 2, failed: 1, averageAttempts: 1.4 },
  agents: {
    total: 4,
    succeeded: 2,
    failed: 1,
    active: 1,
    successRate: 2 / 3,
    totalCostCents: 1234,
    totalTokens: 41_700,
    measuredRuns: 3,
    modelRuns: 4,
    duration: { averageSeconds: 150, minSeconds: 60, maxSeconds: 300 },
  },
  usageByIssue: [
    {
      issueId: 'i2',
      title: 'Api',
      costCents: 900,
      tokens: 41_700,
      measuredRuns: 3,
      modelRuns: 4,
    },
    {
      issueId: 'i1',
      title: 'Schema',
      costCents: 334,
      tokens: null,
      measuredRuns: 0,
      modelRuns: 1,
    },
    {
      issueId: 'i3',
      title: 'Docs',
      costCents: 0,
      tokens: 1_200,
      measuredRuns: 1,
      modelRuns: 1,
    },
  ],
  velocity: {
    last7Days: { closed: 2, perDay: 2 / 7 },
    last14Days: { closed: 2, perDay: 2 / 14 },
    last30Days: { closed: 2, perDay: 2 / 30 },
  },
  closedPerDay: [
    { date: '2026-01-30', count: 0 },
    { date: '2026-01-31', count: 1 },
    { date: '2026-02-01', count: 1 },
  ],
  runs: [
    {
      id: 'r2',
      issueId: 'i2',
      issueTitle: 'Api',
      attemptNumber: 2,
      status: 'success',
      durationSeconds: 90,
      costCents: 900,
      tokens: 41_700,
      prUrl: 'https://github.com/acme/todo-app/pull/7',
      createdAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'r1',
      issueId: 'i1',
      issueTitle: 'Schema',
      attemptNumber: 1,
      status: 'failed',
      durationSeconds: 120,
      costCents: 334,
      tokens: null,
      prUrl: null,
      createdAt: '2026-01-31T00:00:00.000Z',
    },
  ],
};

async function mockStats(page: Page, onStats?: (url: string) => void): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route(/\/api\/projects\/p1$/, (route) => route.fulfill({ json: PROJECT }));
  await page.route(/\/api\/projects\/p1\/stats(\?.*)?$/, (route) => {
    onStats?.(route.request().url());
    return route.fulfill({ json: STATS });
  });
}

async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

test('shows summary cards, charts and the run history', async ({ page }) => {
  await mockStats(page);

  await gotoHydrated(page, '/projects/p1/stats');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app stats' })).toBeVisible();
  await expect(page.getByText('67%')).toBeVisible();
  await expect(page.getByText('$12.34', { exact: true })).toBeVisible();
  await expect(page.getByText('2m 30s').first()).toBeVisible();
  await expect(page.getByText('5', { exact: true })).toBeVisible();
  await expect(page.getByText('1 open · 1 in progress · 2 closed · 1 failed')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Issue status breakdown' })).toBeVisible();
  await expect(
    page.getByText('$12.34 total · ≥ 41.7k tokens across 4 runs', { exact: true }),
  ).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Cost and tokens per issue' })).toBeVisible();
  const usageRows = page.locator('section[aria-labelledby="cost-heading"] li');
  await expect(usageRows).toHaveCount(3);
  await expect(usageRows.first()).toContainText('Api');
  await expect(usageRows.first()).toContainText('$9.00 · ≥ 41.7k tokens');
  await expect(usageRows.last()).toContainText('Docs');
  await expect(usageRows.last()).toContainText('$0.00 · 1.2k tokens');

  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Api');
  await expect(rows.first()).toContainText('success');
  await expect(rows.first()).toContainText('1m 30s');
  await expect(rows.first()).toContainText('$9.00');
  await expect(rows.first().locator('td').nth(5)).toHaveText('41.7k');
  await expect(rows.nth(1).locator('td').nth(5)).toHaveText('—');
  await expect(page.getByRole('link', { name: 'Open PR' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app/pull/7',
  );
});

test('sorts and filters the run history', async ({ page }) => {
  await mockStats(page);
  await gotoHydrated(page, '/projects/p1/stats');

  await page.getByLabel('Sort runs').selectOption('duration');

  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('Schema');
  await expect(rows.first()).toContainText('2m');

  await page.getByLabel('Filter by status').selectOption('failed');

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Schema');
});

test('refetches the stats when the date range changes', async ({ page }) => {
  const urls: string[] = [];
  await mockStats(page, (url) => urls.push(url));

  await gotoHydrated(page, '/projects/p1/stats');
  await expect(page.getByRole('button', { name: '7 days' })).toBeVisible();

  await page.getByRole('button', { name: '7 days' }).click();

  await expect.poll(() => urls.some((url) => url.includes('from='))).toBe(true);
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
