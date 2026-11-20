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

const PLAN = {
  id: 'v1',
  projectId: 'p1',
  version: 1,
  contentMarkdown: '# Plan',
  mode: 'guided',
  source: 'grill-me',
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  acceptedAt: '2026-01-02T00:00:00.000Z',
};

const OVERVIEW = {
  project: PROJECT,
  activePlan: null,
  activeWork: [],
  issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
  lastRunAt: null,
};

const STATS = {
  issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
  agents: {
    total: 0,
    succeeded: 0,
    failed: 0,
    active: 0,
    successRate: 0,
    totalCostCents: 0,
    totalTokens: 0,
    measuredRuns: 0,
    modelRuns: 0,
    duration: { averageSeconds: 0, minSeconds: 0, maxSeconds: 0 },
  },
  usageByIssue: [],
  velocity: {
    last7Days: { closed: 0, perDay: 0 },
    last14Days: { closed: 0, perDay: 0 },
    last30Days: { closed: 0, perDay: 0 },
  },
  closedPerDay: [],
  runs: [],
};

/** A signed-in session with every endpoint the shell's pages touch. */
async function mockApp(page: Page, options: { authenticated?: boolean } = {}): Promise<void> {
  const authenticated = options.authenticated ?? true;
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: {
        setupComplete: true,
        authenticated,
        user: authenticated ? { id: 'u', username: 'alice' } : undefined,
      },
    }),
  );
  await page.route('**/api/overview', (route) => route.fulfill({ json: { overviews: [] } }));
  await page.route('**/api/settings', (route) =>
    route.fulfill({ json: { updatedAt: '2026-01-01T00:00:00.000Z' } }),
  );
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: { models: [], defaultModel: 'openrouter/default-model' } }),
  );
  await page.route('**/api/projects/p1/overview', (route) => route.fulfill({ json: OVERVIEW }));
  await page.route(/\/api\/projects\/p1\/stats(\?.*)?$/, (route) => route.fulfill({ json: STATS }));
  await page.route('**/api/projects/p1/plans/active', (route) => route.fulfill({ json: PLAN }));
  await page.route('**/api/projects/p1/plans', (route) =>
    route.fulfill({ json: { plans: [PLAN] } }),
  );
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: { nodes: [], cycles: [] } }),
  );
  await page.route('**/api/projects/p1/issues', (route) => route.fulfill({ json: { issues: [] } }));
  await page.route('**/api/projects/p1/agent-runs', (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route('**/api/projects/p1/grill', (route) =>
    route.fulfill({
      status: 404,
      json: { error: 'not-found', message: 'No active grill session' },
    }),
  );
  await page.route(/\/api\/projects\/p1$/, (route) => route.fulfill({ json: PROJECT }));
}

async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

test('puts a persistent sidebar and user card on every authenticated page', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the persistent rail is desktop-only');
  await mockApp(page);

  await gotoHydrated(page, '/');

  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();
  const primary = sidebar.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: 'Projects' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(primary.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'href',
    '/settings',
  );
  await expect(page.getByTestId('user-card')).toContainText('alice');
  await expect(sidebar.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('#main-content')).toBeVisible();
});

test('remembers a collapsed sidebar as an icon rail across reloads', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the icon rail is desktop-only');
  await mockApp(page);
  await gotoHydrated(page, '/');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();

  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  // The rail keeps its destinations: hidden labels stay available to assistive tech.
  await expect(sidebar.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThan(100);

  await page.reload();

  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(sidebar.getByRole('link', { name: 'Projects' })).toBeVisible();
});

test('marks the active destination and exposes project tabs and breadcrumbs', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the sidebar destination check is desktop-only');
  await mockApp(page);

  await gotoHydrated(page, '/projects/p1/stats');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app stats' })).toBeVisible();
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toContainText('Projects');
  await expect(breadcrumb).toContainText('todo-app');
  await expect(breadcrumb.getByText('Stats')).toHaveAttribute('aria-current', 'page');

  const tabs = page.getByRole('navigation', { name: 'Project sections' });
  await expect(tabs.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('link', { name: 'Plan' })).toHaveAttribute(
    'href',
    '/projects/p1/plan',
  );
  await expect(tabs.getByRole('link', { name: 'Review' })).toHaveAttribute(
    'href',
    '/projects/p1/issues/review',
  );

  const primary = page.getByTestId('sidebar').getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: 'Projects' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('does not render the shell on login', async ({ page }) => {
  await mockApp(page, { authenticated: false });

  await gotoHydrated(page, '/login');

  await expect(page.getByRole('heading', { name: 'Sign in to YAAABK' })).toBeVisible();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveCount(0);
});

test('makes the skip link the first tab stop and moves focus to main content', async ({ page }) => {
  await mockApp(page);
  await gotoHydrated(page, '/');

  await page.keyboard.press('Tab');

  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();

  await page.keyboard.press('Enter');

  await expect(page.locator('#main-content')).toBeFocused();
});

test('keeps every authenticated page inside 360px without horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockApp(page);

  for (const [path, heading] of [
    ['/', 'Projects'],
    ['/settings', 'Settings'],
    ['/projects/new', 'New project'],
    ['/projects/p1', 'todo-app'],
    ['/projects/p1/plan', 'todo-app'],
    ['/projects/p1/issues', 'Issue board'],
    ['/projects/p1/issues/review', 'Review plan'],
    ['/projects/p1/stats', 'todo-app stats'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens the drawer, traps focus, closes on Escape and restores the trigger', async ({
    page,
  }) => {
    await mockApp(page);
    await gotoHydrated(page, '/');

    const trigger = page.getByRole('button', { name: 'Open navigation' });
    await expect(trigger).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeHidden();

    await trigger.click();

    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Projects' })).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      const inside = await drawer.evaluate((element) => element.contains(document.activeElement));
      expect(inside).toBe(true);
    }

    await page.keyboard.press('Escape');

    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
