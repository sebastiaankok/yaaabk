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
  deployedCommitSha: 'abc1234',
  lastDeployStatus: 'success',
  lastDeployAt: '2026-01-02T03:04:05.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const MODELS = {
  models: [
    { id: 'openrouter/default-model', name: 'Default model' },
    { id: 'openrouter/chosen', name: 'Chosen model' },
  ],
  defaultModel: 'openrouter/default-model',
};

/** A Project overview around the fixture Project. */
function overview(overrides: Record<string, unknown> = {}) {
  return {
    project: PROJECT,
    activePlan: null,
    activeWork: [],
    issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
    lastRunAt: null,
    ...overrides,
  };
}

async function mockProject(
  page: Page,
  projectOverview: Record<string, unknown> | (() => Record<string, unknown>) = overview(),
): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1/overview', (route) =>
    route.fulfill({
      json: typeof projectOverview === 'function' ? projectOverview() : projectOverview,
    }),
  );
  await page.route('**/api/models', (route) => route.fulfill({ json: MODELS }));
}

/**
 * Navigates and waits until the client app has hydrated (the root layout
 * fetches `/api/auth/status` once running).
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

test('shows the provisioned project with links to its tooling', async ({ page }) => {
  await mockProject(page);

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  await expect(page.getByText('Guided')).toBeVisible();
  await expect(page.getByRole('link', { name: 'acme/todo-app' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app',
  );
  await expect(page.getByText('yaaabk-a1b2c3d4')).toBeVisible();
  await expect(page.getByText('Deployed commit')).toBeVisible();
  await expect(page.getByText('abc1234')).toBeVisible();
  await expect(page.getByText('Last deploy')).toBeVisible();
  await expect(page.getByText('Succeeded')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Agent' })).toHaveAttribute(
    'href',
    '/projects/p1/plan',
  );
  await expect(page.getByRole('link', { name: 'Stats' })).toHaveAttribute(
    'href',
    '/projects/p1/stats',
  );
});

test('banners an unaccepted active plan and links to review', async ({ page }) => {
  await mockProject(page, overview({ activePlan: { id: 'plan-1', version: 2, acceptedAt: null } }));

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByRole('link', { name: 'Plan v2 not accepted' })).toHaveAttribute(
    'href',
    '/projects/p1/issues/review',
  );
});

test('lists active work and links each row to its issue', async ({ page }) => {
  await mockProject(
    page,
    overview({
      activeWork: [
        {
          id: 'r1',
          issueId: 'i1',
          issueTitle: 'Schema',
          kind: 'implement-issue',
          attemptNumber: 2,
          status: 'running',
          createdAt: '2026-02-03T01:00:00.000Z',
          startedAt: '2026-02-03T01:01:00.000Z',
        },
        {
          id: 'r2',
          issueId: 'i2',
          issueTitle: 'Api',
          kind: 'review',
          attemptNumber: 1,
          status: 'queued',
          createdAt: '2026-02-04T02:00:00.000Z',
          startedAt: null,
        },
      ],
    }),
  );

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByRole('heading', { name: 'Active work' })).toBeVisible();
  const schema = page.getByRole('link', { name: /Schema/ });
  await expect(schema).toHaveAttribute('href', '/projects/p1/issues?issue=i1');
  await expect(schema).toContainText('Attempt 2');
  await expect(schema).toContainText('running');
  await expect(schema).toContainText('Started 2026-02-03 01:01');

  const api = page.getByRole('link', { name: /Api/ });
  await expect(api).toHaveAttribute('href', '/projects/p1/issues?issue=i2');
  await expect(api).toContainText('Review 1');
  await expect(api).toContainText('queued');
  await expect(api).toContainText('Queued 2026-02-04 02:00');
});

test('shows an explicit idle state when no agent runs are in flight', async ({ page }) => {
  await mockProject(page);

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByText('Idle — no agent runs in flight.')).toBeVisible();
});

test('polls active work and the plan banner without clobbering unsaved forms', async ({ page }) => {
  let current = overview();
  await mockProject(page, () => current);

  const patches: unknown[] = [];
  await page.route('**/api/projects/p1', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...PROJECT } });
      return;
    }
    await route.fallback();
  });

  await gotoHydrated(page, '/projects/p1');
  await expect(page.getByText('Idle — no agent runs in flight.')).toBeVisible();
  await page.getByLabel('GitHub username').fill('dev');
  await page.getByLabel('Default agent model').fill('openrouter/unsaved');

  // The next poll sees an unaccepted Plan and a queued run appear.
  current = overview({
    activePlan: { id: 'plan-2', version: 2, acceptedAt: null },
    activeWork: [
      {
        id: 'r3',
        issueId: 'i3',
        issueTitle: 'Auth',
        kind: 'implement-issue',
        attemptNumber: 1,
        status: 'queued',
        createdAt: '2026-02-05T03:00:00.000Z',
        startedAt: null,
      },
    ],
  });

  await expect(page.getByRole('link', { name: 'Plan v2 not accepted' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('link', { name: /Auth/ })).toHaveAttribute(
    'href',
    '/projects/p1/issues?issue=i3',
  );
  await expect(page.getByLabel('Default agent model')).toHaveValue('openrouter/unsaved');
  await expect(page.getByLabel('GitHub username')).toHaveValue('dev');
  expect(patches).toHaveLength(0);
});

test('shows no plan banner when the active plan is accepted', async ({ page }) => {
  await mockProject(
    page,
    overview({
      activePlan: { id: 'plan-1', version: 2, acceptedAt: '2026-02-02T00:00:00.000Z' },
    }),
  );

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
  await expect(page.getByText(/not accepted/)).toHaveCount(0);
});

test('saves the project agent model and clears it', async ({ page }) => {
  await mockProject(page);
  let state: Record<string, unknown> = { ...PROJECT };
  const patches: unknown[] = [];
  await page.route('**/api/projects/p1', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      state = { ...state, ...(route.request().postDataJSON() as Record<string, unknown>) };
      await route.fulfill({ json: state });
      return;
    }
    await route.fulfill({ json: state });
  });

  await gotoHydrated(page, '/projects/p1');

  const input = page.getByLabel('Default agent model');
  await expect(page.getByText('Used by issues without an override:')).toBeVisible();
  await expect(page.getByText('openrouter/default-model', { exact: false })).toBeVisible();
  await input.fill('openrouter/chosen');
  await input.press('Tab');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await input.fill('');
  await input.press('Tab');
  await expect
    .poll(() => patches)
    .toEqual([{ agentModel: 'openrouter/chosen' }, { agentModel: null }]);
});

test('shows a failed last deploy to the developer', async ({ page }) => {
  await mockProject(
    page,
    overview({
      project: { ...PROJECT, deployedCommitSha: null, lastDeployStatus: 'failed' },
    }),
  );

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByText('Last deploy')).toBeVisible();
  await expect(page.getByText('Failed')).toBeVisible();
  await expect(page.getByText('Not yet deployed')).toBeVisible();
});

test('deletes the project after confirmation', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/overview', (route) => route.fulfill({ json: { overviews: [] } }));
  const deletes: string[] = [];
  await page.route('**/api/projects/p1', async (route) => {
    if (route.request().method() === 'DELETE') {
      deletes.push(route.request().url());
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fallback();
  });

  await gotoHydrated(page, '/projects/p1');
  await page.getByRole('button', { name: 'Delete project' }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  expect(deletes).toHaveLength(1);
});

test('exports the project to the developer github account', async ({ page }) => {
  await mockProject(page);
  const exports: Array<{ url: string; body: unknown }> = [];
  await page.route('**/api/projects/p1/export', async (route) => {
    exports.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({
      json: { ...PROJECT, repoFullName: 'dev/todo', repoUrl: 'https://github.com/dev/todo' },
    });
  });

  await gotoHydrated(page, '/projects/p1');
  await page.getByLabel('GitHub username').fill('dev');
  await page.getByLabel('Repository name', { exact: false }).fill('todo');
  await page.getByRole('button', { name: 'Transfer' }).click();

  await expect(page.getByRole('link', { name: 'dev/todo' })).toBeVisible();
  await expect(page.getByText('Project exported to dev/todo')).toBeVisible();
  expect(exports).toHaveLength(1);
  expect(exports[0]?.body).toEqual({ owner: 'dev', repoName: 'todo' });
});
