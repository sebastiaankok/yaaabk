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

test('shows the provisioned project with one primary action', async ({ page }) => {
  await mockProject(page);

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  const status = page.getByRole('list', { name: 'Project status' });
  await expect(status.getByText('Guided mode')).toBeVisible();
  await expect(page.getByRole('link', { name: 'acme/todo-app' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app',
  );
  await expect(status.getByText('yaaabk-a1b2c3d4')).toBeVisible();
  await expect(page.getByText('Deployed commit')).toBeVisible();
  await expect(page.getByText('abc1234')).toBeVisible();
  await expect(status.getByText('Deploy succeeded')).toBeVisible();
  await expect(page.getByTestId('primary-action')).toHaveText('Start a Plan');
  await expect(page.getByTestId('primary-action')).toHaveAttribute('href', '/projects/p1/plan');
  await expect(
    page.getByTestId('project-tabs').getByRole('link', { name: 'Stats' }),
  ).toHaveAttribute('href', '/projects/p1/stats');
});

test('asks for a review while the active Plan is unaccepted', async ({ page }) => {
  await mockProject(page, overview({ activePlan: { id: 'plan-1', version: 2, acceptedAt: null } }));

  await gotoHydrated(page, '/projects/p1');

  const action = page.getByTestId('primary-action');
  await expect(action).toHaveText('Review Plan v2');
  await expect(action).toHaveAttribute('href', '/projects/p1/issues/review');
  await expect(
    page.getByText('Plan v2 is waiting for review. Accept it to publish its Issues to GitHub.'),
  ).toBeVisible();
});

test('shows the pending review and active run count in the project tabs', async ({ page }) => {
  await mockProject(
    page,
    overview({
      activePlan: { id: 'plan-2', version: 2, acceptedAt: null },
      activeWork: [
        {
          id: 'r1',
          issueId: 'i1',
          issueTitle: 'Schema',
          kind: 'implement-issue',
          attemptNumber: 1,
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

  const tabs = page.getByTestId('project-tabs');
  await expect(tabs.getByTestId('review-indicator')).toBeVisible();
  await expect(tabs.getByRole('link', { name: /Plan v2 not accepted/ })).toBeVisible();
  await expect(tabs.getByTestId('issues-indicator')).toHaveText('2');
  await expect(tabs.getByRole('link', { name: /2 active agent runs/ })).toBeVisible();
});

test('shows no tab indicators without a pending review or active runs', async ({ page }) => {
  await mockProject(
    page,
    overview({
      activePlan: { id: 'plan-1', version: 2, acceptedAt: '2026-02-02T00:00:00.000Z' },
    }),
  );

  await gotoHydrated(page, '/projects/p1');

  const tabs = page.getByTestId('project-tabs');
  await expect(tabs.getByTestId('review-indicator')).toHaveCount(0);
  await expect(tabs.getByTestId('issues-indicator')).toHaveCount(0);
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
  await page.getByTestId('advanced').locator('summary').click();
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

  await expect(page.getByTestId('primary-action')).toHaveText('Review Plan v2', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('primary-action')).toHaveAttribute(
    'href',
    '/projects/p1/issues/review',
  );
  await expect(page.getByRole('link', { name: /Auth/ })).toHaveAttribute(
    'href',
    '/projects/p1/issues?issue=i3',
  );
  const tabs = page.getByTestId('project-tabs');
  await expect(tabs.getByTestId('review-indicator')).toBeVisible();
  await expect(tabs.getByTestId('issues-indicator')).toHaveText('1');
  await expect(page.getByLabel('Default agent model')).toHaveValue('openrouter/unsaved');
  await expect(page.getByLabel('GitHub username')).toHaveValue('dev');
  expect(patches).toHaveLength(0);
});

test('offers no primary action when the active plan is accepted', async ({ page }) => {
  await mockProject(
    page,
    overview({
      activePlan: { id: 'plan-1', version: 2, acceptedAt: '2026-02-02T00:00:00.000Z' },
    }),
  );

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByTestId('primary-action')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Start a Plan' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Review Plan/ })).toHaveCount(0);
  await expect(page.getByText(/not accepted/)).toHaveCount(0);
});

test('saves the project agent model and clears it', async ({ page }) => {
  await mockProject(page);
  let state: Record<string, unknown> = { ...PROJECT };
  const patches: unknown[] = [];
  await page.route('**/api/projects/p1', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 300));
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
  await expect(page.getByText('Saving…')).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await input.fill('');
  await input.press('Tab');
  await expect
    .poll(() => patches)
    .toEqual([{ agentModel: 'openrouter/chosen' }, { agentModel: null }]);
});

test('reports a failed agent model save in place', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/projects/p1', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({
        status: 500,
        json: { error: 'internal', message: 'Could not save the agent model.' },
      });
      return;
    }
    await route.fallback();
  });

  await gotoHydrated(page, '/projects/p1');

  const input = page.getByLabel('Default agent model');
  await input.fill('openrouter/chosen');
  await input.press('Tab');

  await expect(page.getByRole('alert')).toHaveText('Could not save the agent model.');
  await expect(input).toHaveValue('');
  await expect(
    page.getByTestId('agent-model-card').getByText('Could not save the agent model.'),
  ).toBeVisible();
});

test('places resources beside the agent model on wide screens', async ({ page }, testInfo) => {
  await mockProject(page);
  await gotoHydrated(page, '/projects/p1');

  const resources = page.getByTestId('provisioned-resources');
  const model = page.getByTestId('agent-model-card');
  await expect(resources).toBeVisible();
  await expect(model).toBeVisible();

  const resourcesBox = await resources.boundingBox();
  const modelBox = await model.boundingBox();
  expect(resourcesBox).not.toBeNull();
  expect(modelBox).not.toBeNull();

  if (testInfo.project.name === 'desktop') {
    expect(Math.abs((resourcesBox?.y ?? 0) - (modelBox?.y ?? 0))).toBeLessThan(8);
    expect(modelBox?.x ?? 0).toBeGreaterThanOrEqual(
      (resourcesBox?.x ?? 0) + (resourcesBox?.width ?? 0),
    );
  } else {
    expect(modelBox?.y ?? 0).toBeGreaterThanOrEqual(
      (resourcesBox?.y ?? 0) + (resourcesBox?.height ?? 0),
    );
  }
});

test('fits a 360px phone without horizontal scrolling', async ({ page }) => {
  await mockProject(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByTestId('primary-action')).toBeVisible();
  await page.getByTestId('advanced').locator('summary').click();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialogOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(dialogOverflow).toBeLessThanOrEqual(0);
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
  await expect(
    page.getByRole('list', { name: 'Project status' }).getByText('Deploy failed'),
  ).toBeVisible();
  await expect(
    page.getByTestId('provisioned-resources').getByText('Failed', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Not yet deployed')).toBeVisible();
});

test('confirms deletion in an accessible dialog', async ({ page }) => {
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

  // Advanced starts collapsed, and opens from the keyboard.
  await expect(page.getByRole('button', { name: 'Delete project' })).toBeHidden();
  const summary = page.getByTestId('advanced').locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');

  const trigger = page.getByRole('button', { name: 'Delete project' });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('todo-app');
  await expect(dialog).toContainText('acme/todo-app');
  await expect(dialog).toContainText('yaaabk-a1b2c3d4');
  await expect(dialog).toContainText('cannot be undone');

  // Focus is trapped in the dialog; Escape closes and restores the trigger.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
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
  await page.getByTestId('advanced').locator('summary').click();
  await page.getByLabel('GitHub username').fill('dev');
  await page.getByLabel('Repository name', { exact: false }).fill('todo');
  await page.getByRole('button', { name: 'Transfer' }).click();

  await expect(page.getByRole('link', { name: 'dev/todo' })).toBeVisible();
  await expect(page.getByText('Project exported to dev/todo')).toBeVisible();
  expect(exports).toHaveLength(1);
  expect(exports[0]?.body).toEqual({ owner: 'dev', repoName: 'todo' });
});
