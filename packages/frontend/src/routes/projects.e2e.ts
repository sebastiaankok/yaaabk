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
  lastDeployStatus: 'failed',
  lastDeployAt: '2026-02-03T09:30:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SECOND_PROJECT = {
  ...PROJECT,
  id: 'p2',
  name: 'notes-app',
  description:
    'Notes with a very long description that must wrap inside its card instead of pushing the grid wider than a phone screen',
  namespace: 'yaaabk-e5f6a7b8',
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

test('lists every project as a card with its key metadata', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page);

  await gotoHydrated(page, '/');

  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New project' })).toHaveAttribute(
    'href',
    '/projects/new',
  );

  const card = page.getByTestId('project-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('link', { name: 'todo-app' })).toHaveAttribute(
    'href',
    '/projects/p1',
  );
  await expect(card.getByText('A todo list')).toBeVisible();
  await expect(card.getByText('Guided')).toBeVisible();
  await expect(card.getByText('yaaabk-a1b2c3d4')).toBeVisible();
  await expect(card.getByText('1 open · 2 closed')).toBeVisible();
  await expect(card.getByText('2026-02-01', { exact: false })).toBeVisible();
  await expect(card.getByText('Failed', { exact: false })).toBeVisible();
  await expect(card.getByText('2026-02-03', { exact: false })).toBeVisible();
  await expect(card.getByText('Idle')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Plan' })).toHaveAttribute(
    'href',
    '/projects/p1/plan',
  );
  await expect(card.getByRole('link', { name: 'Issues' })).toHaveAttribute(
    'href',
    '/projects/p1/issues',
  );
  await expect(card.getByRole('link', { name: 'Stats' })).toHaveAttribute(
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
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: { nodes: [], cycles: [] } }),
  );
  await page.route('**/api/projects/p1/issues', (route) => route.fulfill({ json: { issues: [] } }));
  await page.route('**/api/projects/p1/plans', (route) => route.fulfill({ json: { plans: [] } }));
  await page.route(/\/api\/projects\/p1$/, (route) => route.fulfill({ json: PROJECT }));

  await gotoHydrated(page, '/');

  const card = page.getByTestId('project-card');
  const banner = card.getByTestId('plan-banner');
  await expect(banner).toBeVisible();
  const review = card.getByRole('link', { name: 'Plan v3 not accepted' });
  await expect(review).toHaveAttribute('href', '/projects/p1/issues/review');
  await expect(card.getByText('Active · 1 running')).toBeVisible();

  await review.click();

  await expect(page).toHaveURL('/projects/p1/issues/review');
  await expect(page.getByRole('heading', { level: 1, name: 'Review plan' })).toBeVisible();
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

  await expect(page.getByTestId('plan-banner')).toHaveCount(0);
  await expect(page.getByText('Idle')).toBeVisible();
});

test('invites the Developer to create the first project when there are none', async ({ page }) => {
  await mockAuth(page);
  await mockOverview(page, []);

  await gotoHydrated(page, '/');

  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New project' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first project' })).toHaveAttribute(
    'href',
    '/projects/new',
  );
  await expect(page.getByTestId('project-card')).toHaveCount(0);
});

test('shows busy skeleton cards before the projects arrive', async ({ page }) => {
  await mockAuth(page);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/overview', async (route) => {
    await gate;
    await route.fulfill({ json: { overviews: [IDLE_OVERVIEW] } });
  });

  await gotoHydrated(page, '/');

  const loading = page.getByTestId('projects-loading');
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  const skeletons = loading.getByTestId('project-skeleton');
  expect(await skeletons.count()).toBeGreaterThan(0);
  expect(
    await skeletons.evaluateAll((elements) =>
      elements.every((element) => element.getAttribute('aria-hidden') === 'true'),
    ),
  ).toBe(true);
  await expect(page.getByRole('link', { name: 'New project' })).toBeVisible();
  await expect(page.getByTestId('project-card')).toHaveCount(0);

  release();

  await expect(page.getByTestId('project-card')).toHaveCount(1);
  await expect(loading).toHaveCount(0);
});

test('surfaces a load failure and retries', async ({ page }) => {
  await mockAuth(page);

  let attempts = 0;
  await page.route('**/api/overview', (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        status: 502,
        json: { error: 'kubernetes', message: 'cluster unreachable' },
      });
    }
    return route.fulfill({ json: { overviews: [IDLE_OVERVIEW] } });
  });

  await gotoHydrated(page, '/');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not load projects');
  await expect(alert).toContainText('cluster unreachable');
  await expect(page.getByRole('link', { name: 'New project' })).toBeVisible();
  await expect(page.getByTestId('project-card')).toHaveCount(0);

  await alert.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByTestId('project-card')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(attempts).toBe(2);
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

test('stacks cards in one column at 360px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockAuth(page);
  await mockOverview(page, [
    IDLE_OVERVIEW,
    { ...IDLE_OVERVIEW, project: SECOND_PROJECT, issues: { ...ISSUES, open: 0, closed: 0 } },
  ]);

  await gotoHydrated(page, '/');

  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole('link', { name: 'New project' })).toBeVisible();

  const cards = page.getByTestId('project-card');
  await expect(cards).toHaveCount(2);
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.x).toBeCloseTo(first!.x, 0);
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
});
