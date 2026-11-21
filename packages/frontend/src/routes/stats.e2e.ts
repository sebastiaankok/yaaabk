import { expect, test, type Page } from '@playwright/test';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  mode: 'guided',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
  deployedCommitSha: null,
  lastDeployStatus: null,
  lastDeployAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const OVERVIEW = {
  project: PROJECT,
  activePlan: null,
  activeWork: [],
  issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
  lastRunAt: null,
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

const SHORT_STATS = {
  issues: { total: 2, open: 0, inProgress: 0, closed: 2, failed: 0, averageAttempts: 1 },
  agents: {
    total: 1,
    succeeded: 1,
    failed: 0,
    active: 0,
    successRate: 1,
    totalCostCents: 500,
    totalTokens: 1_200,
    measuredRuns: 1,
    modelRuns: 1,
    duration: { averageSeconds: 60, minSeconds: 60, maxSeconds: 60 },
  },
  usageByIssue: [
    {
      issueId: 'i1',
      title: 'Schema',
      costCents: 500,
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
    { date: '2026-01-26', count: 0 },
    { date: '2026-01-27', count: 0 },
    { date: '2026-01-28', count: 1 },
    { date: '2026-01-29', count: 0 },
    { date: '2026-01-30', count: 0 },
    { date: '2026-01-31', count: 1 },
    { date: '2026-02-01', count: 0 },
  ],
  runs: [
    {
      id: 'r2',
      issueId: 'i1',
      issueTitle: 'Schema',
      attemptNumber: 1,
      status: 'success',
      durationSeconds: 60,
      costCents: 500,
      tokens: 1_200,
      prUrl: null,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
  ],
};

const EMPTY_STATS = {
  issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
  agents: {
    total: 0,
    succeeded: 0,
    failed: 0,
    active: 0,
    successRate: null,
    totalCostCents: 0,
    totalTokens: null,
    measuredRuns: 0,
    modelRuns: 0,
    duration: { averageSeconds: null, minSeconds: null, maxSeconds: null },
  },
  usageByIssue: [],
  velocity: {
    last7Days: { closed: 0, perDay: 0 },
    last14Days: { closed: 0, perDay: 0 },
    last30Days: { closed: 0, perDay: 0 },
  },
  closedPerDay: [
    { date: '2026-01-30', count: 0 },
    { date: '2026-01-31', count: 0 },
    { date: '2026-02-01', count: 0 },
  ],
  runs: [],
};

/** How many days the stats request asks for, read from the ISO range. */
function requestedDays(url: string): number {
  const params = new URL(url).searchParams;
  const from = params.get('from');
  const to = params.get('to');
  if (from === null || to === null) return 30;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

interface MockOptions {
  onStats?: (url: string) => void;
  respond?: (url: string) => unknown;
  delayMs?: number;
}

async function mockStats(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route(/\/api\/projects\/p1$/, (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects/p1/overview', (route) => route.fulfill({ json: OVERVIEW }));
  await page.route(/\/api\/projects\/p1\/stats(\?.*)?$/, async (route) => {
    const url = route.request().url();
    options.onStats?.(url);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    return route.fulfill({ json: options.respond?.(url) ?? STATS });
  });
}

async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

/** Whether the current project shows the run history as cards instead of a table. */
function usesRunCards(): boolean {
  return test.info().project.name === 'mobile';
}

function runCards(page: Page) {
  return page.getByTestId('run-card');
}

function runRows(page: Page) {
  return page.getByTestId('run-table').locator('tbody tr');
}

/** The run-history item the current layout renders first. */
function firstRun(page: Page) {
  return usesRunCards() ? runCards(page).first() : runRows(page).first();
}

/** Asserts which history layout is visible and how many runs it shows. */
async function expectRunCount(page: Page, count: number): Promise<void> {
  if (usesRunCards()) {
    await expect(page.getByTestId('run-cards')).toBeVisible();
    await expect(page.getByTestId('run-table')).toBeHidden();
    await expect(runCards(page)).toHaveCount(count);
  } else {
    await expect(page.getByTestId('run-table')).toBeVisible();
    await expect(page.getByTestId('run-cards')).toBeHidden();
    await expect(runRows(page)).toHaveCount(count);
  }
}

test('shows KPI tiles, accessible charts and the run history', async ({ page }) => {
  await mockStats(page);

  await gotoHydrated(page, '/projects/p1/stats');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app stats' })).toBeVisible();

  const tiles = page.locator('section[aria-labelledby="summary-heading"] dd');
  await expect(tiles.first()).toHaveText('5');
  await expect(page.getByText('67%')).toBeVisible();
  await expect(page.getByText('$12.34', { exact: true })).toBeVisible();
  await expect(page.getByText('2m 30s').first()).toBeVisible();
  await expect(page.getByText('1 open · 1 in progress · 2 closed · 1 failed')).toBeVisible();
  await expect(page.getByText('≥ 41.7k tokens across 4 runs', { exact: true })).toBeVisible();

  const donut = page.getByRole('img', { name: 'Issue status breakdown' });
  await expect(donut).toBeVisible();
  const legend = page.locator('section[aria-labelledby="status-heading"] li');
  await expect(legend).toHaveCount(4);
  await expect(legend.first()).toContainText('Open');
  await expect(legend.first()).toContainText('1');
  await expect(legend.first()).toContainText('20%');
  await expect(legend.nth(2)).toContainText('Closed');
  await expect(legend.nth(2)).toContainText('2');
  await expect(legend.nth(2)).toContainText('40%');

  const throughput = page.getByRole('slider', { name: /Issues closed per day/ });
  await expect(throughput).toBeVisible();
  await expect(throughput).toHaveAttribute('aria-valuemax', '3');
  await throughput.focus();
  await expect(throughput).toHaveAttribute('aria-valuetext', '2026-01-30: 0 Issues closed');
  await throughput.press('End');
  await expect(throughput).toHaveAttribute('aria-valuetext', '2026-02-01: 1 Issue closed');
  await expect(page.getByTestId('throughput-status')).toContainText('2026-02-01');

  await page.getByText('View data table').click();
  const table = page.locator('section[aria-labelledby="velocity-heading"] table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').last()).toContainText('2026-02-01');
  await expect(table.locator('tbody tr').last()).toContainText('1');

  await expect(page.getByRole('heading', { name: 'Cost and tokens per issue' })).toBeVisible();
  const usageRows = page.locator('section[aria-labelledby="cost-heading"] li');
  await expect(usageRows).toHaveCount(3);
  await expect(usageRows.first()).toContainText('Api');
  await expect(usageRows.first()).toContainText('$9.00 · ≥ 41.7k tokens');
  await expect(usageRows.last()).toContainText('Docs');
  await expect(usageRows.last()).toContainText('$0.00 · 1.2k tokens');

  const duration = page.locator('section[aria-labelledby="duration-heading"]');
  await expect(duration).toContainText('2m');
  await expect(duration).toContainText('1m 30s');
  await expect(duration).toContainText('1 run');

  await expectRunCount(page, 2);
  await expect(firstRun(page)).toContainText('Api');
  await expect(firstRun(page)).toContainText('success');
  await expect(firstRun(page)).toContainText('1m 30s');
  await expect(firstRun(page)).toContainText('$9.00');
  await expect(firstRun(page)).toContainText('41.7k');
  await expect(firstRun(page)).toContainText('2026-02-01');
  if (usesRunCards()) {
    for (const label of ['Attempt', 'Duration', 'Cost', 'Tokens', 'PR', 'Started']) {
      await expect(firstRun(page)).toContainText(label);
    }
    await expect(runCards(page).nth(1)).toContainText('—');
  } else {
    await expect(runRows(page).first().locator('td').nth(5)).toHaveText('41.7k');
    await expect(runRows(page).nth(1).locator('td').nth(5)).toHaveText('—');
  }
  await expect(page.getByRole('link', { name: 'Open PR' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app/pull/7',
  );
});

test('sorts and filters the run history alongside the range switcher', async ({ page }) => {
  const urls: string[] = [];
  await mockStats(page, {
    onStats: (url) => urls.push(url),
    respond: (url) => (requestedDays(url) === 7 ? SHORT_STATS : STATS),
  });
  await gotoHydrated(page, '/projects/p1/stats');

  await page.getByLabel('Sort runs').selectOption('duration');

  await expectRunCount(page, 2);
  await expect(firstRun(page)).toContainText('Schema');
  await expect(firstRun(page)).toContainText('2m');

  await page.getByLabel('Filter by status').selectOption('failed');

  await expectRunCount(page, 1);
  await expect(firstRun(page)).toContainText('Schema');

  await page.getByRole('button', { name: '7 days' }).click();

  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('run-history-empty')).toBeVisible();
  await expect(
    page.getByText('No runs with status failed in the last 7 days', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      '1 run in this range has another status. Clear the filter or change the range.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect.poll(() => urls.filter((url) => requestedDays(url) === 7).length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Clear status filter' }).click();

  await expect(page.getByLabel('Filter by status')).toHaveValue('all');
  await expect(page.getByTestId('run-history-empty')).toHaveCount(0);
  await expectRunCount(page, 1);
  await expect(firstRun(page)).toContainText('Schema');
});

test('uses a table at 720px and summary cards below it', async ({ page }) => {
  await page.setViewportSize({ width: 719, height: 900 });
  await mockStats(page);
  await gotoHydrated(page, '/projects/p1/stats');

  await expect(page.getByTestId('run-cards')).toBeVisible();
  await expect(page.getByTestId('run-table')).toBeHidden();
  const card = runCards(page).first();
  for (const text of ['Api', 'Attempt', '2', 'success', '1m 30s', '$9.00', '41.7k', 'Started']) {
    await expect(card).toContainText(text);
  }
  await expect(card.getByRole('link', { name: 'Open PR' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app/pull/7',
  );

  await page.setViewportSize({ width: 720, height: 900 });

  await expect(page.getByTestId('run-table')).toBeVisible();
  await expect(page.getByTestId('run-cards')).toBeHidden();
});

test('explains a status filter that matches nothing and clears it', async ({ page }) => {
  await mockStats(page);
  await gotoHydrated(page, '/projects/p1/stats');

  await page.getByLabel('Filter by status').selectOption('queued');

  await expect(page.getByTestId('run-history-empty')).toBeVisible();
  await expect(
    page.getByText('No runs with status queued in the last 30 days', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      '2 runs in this range have another status. Clear the filter or change the range.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Clear status filter' }).click();

  await expect(page.getByTestId('run-history-empty')).toHaveCount(0);
  await expectRunCount(page, 2);
});

test('refetches KPIs and charts when the date range changes', async ({ page }) => {
  const urls: string[] = [];
  await mockStats(page, {
    onStats: (url) => urls.push(url),
    respond: (url) => (requestedDays(url) === 7 ? SHORT_STATS : STATS),
  });

  await gotoHydrated(page, '/projects/p1/stats');
  await expect(page.getByRole('button', { name: '7 days' })).toBeVisible();
  await expect(page.getByRole('slider', { name: /over the last 30 days/ })).toBeVisible();
  await expect(
    page.locator('section[aria-labelledby="summary-heading"]').getByText('$12.34', {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: '7 days' }).click();

  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('section[aria-labelledby="summary-heading"]').getByText('$5.00', {
      exact: true,
    }),
  ).toBeVisible();
  const tiles = page.locator('section[aria-labelledby="summary-heading"] dd');
  await expect(tiles.first()).toHaveText('2');
  await expect(page.getByRole('slider', { name: /over the last 7 days/ })).toBeVisible();
  await expect.poll(() => urls.filter((url) => requestedDays(url) === 7).length).toBeGreaterThan(0);
});

test('shows a busy loading state before the stats arrive', async ({ page }) => {
  await mockStats(page, { delayMs: 600 });

  await gotoHydrated(page, '/projects/p1/stats');

  const loading = page.getByLabel('Loading stats');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-busy', 'true');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app stats' })).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test('explains an empty range instead of drawing hollow charts', async ({ page }) => {
  await mockStats(page, { respond: () => EMPTY_STATS });

  await gotoHydrated(page, '/projects/p1/stats');

  const tiles = page.locator('section[aria-labelledby="summary-heading"] dd');
  await expect(tiles.first()).toHaveText('0');

  await expect(
    page.getByText('No Issues were closed in the last 30 days.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('slider', { name: /Issues closed per day/ })).toHaveCount(0);
  await expect(page.getByText('No Issues in this Project yet.', { exact: false })).toBeVisible();
  await expect(
    page.getByText('No agent spend or token usage in the last 30 days.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('No completed agent runs in the last 30 days.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('No agent runs in the last 30 days', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Widen the range or start an agent to see runs here.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('run-history-empty')).toBeVisible();
  await expect(page.getByTestId('run-cards')).toBeHidden();
  await expect(page.getByTestId('run-table')).toBeHidden();
});

test('inspects chart points with the pointer and restores the hint', async ({ page }) => {
  await mockStats(page);
  await gotoHydrated(page, '/projects/p1/stats');

  const throughput = page.getByRole('slider', { name: /Issues closed per day/ });
  const box = await throughput.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;

  if (test.info().project.name === 'mobile') {
    await throughput.focus();
    await throughput.press('End');
  } else {
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  }
  await expect(throughput).toHaveAttribute('aria-valuetext', '2026-02-01: 1 Issue closed');

  if (test.info().project.name === 'mobile') return;

  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await expect(throughput).toHaveAttribute('aria-valuetext', '2026-01-30: 0 Issues closed');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
  await expect(page.getByText('Hover or focus the chart to inspect a day.')).toBeVisible();
});

test('reflows chart cards and tiles at 360px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockStats(page);
  await gotoHydrated(page, '/projects/p1/stats');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app stats' })).toBeVisible();
  await expect(page.getByRole('slider', { name: /Issues closed per day/ })).toBeVisible();
  await expect(page.getByTestId('run-cards')).toBeVisible();
  await expect(page.getByTestId('run-table')).toBeHidden();
  await expect(runCards(page)).toHaveCount(2);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
