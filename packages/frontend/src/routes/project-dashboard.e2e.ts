import { expect, test, type Page } from '@playwright/test';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  skillLevel: 'expert',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
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

async function mockProject(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
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
  await expect(page.getByText('expert')).toBeVisible();
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
  await mockProject(page);
  await page.route('**/api/projects/p1', (route) =>
    route.fulfill({
      json: { ...PROJECT, deployedCommitSha: null, lastDeployStatus: 'failed' },
    }),
  );

  await gotoHydrated(page, '/projects/p1');

  await expect(page.getByText('Last deploy')).toBeVisible();
  await expect(page.getByText('Failed')).toBeVisible();
  await expect(page.getByText('Not yet deployed')).toBeVisible();
});

test('deletes the project after confirmation', async ({ page }) => {
  await mockProject(page);
  const deletes: string[] = [];
  await page.route('**/api/projects/p1', async (route) => {
    if (route.request().method() === 'DELETE') {
      deletes.push(route.request().url());
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: [] } }));

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

test('shows validation errors without calling the export endpoint', async ({ page }) => {
  await mockProject(page);
  const exports: string[] = [];
  await page.route('**/api/projects/p1/export', (route) => {
    exports.push(route.request().url());
    return route.fulfill({ json: {} });
  });

  await gotoHydrated(page, '/projects/p1');
  await page.getByRole('button', { name: 'Transfer' }).click();

  await expect(page.getByText('A GitHub username is required')).toBeVisible();
  expect(exports).toHaveLength(0);
});
