import { expect, test, type Page } from '@playwright/test';

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

async function mockAuth(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
}

/**
 * Navigates and waits until the client app has hydrated (the root layout
 * fetches `/api/auth/status` once running). Without this a click can land before
 * hydration and submit a form natively.
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

test('rejects an invalid name before advancing', async ({ page }) => {
  await mockAuth(page);

  await gotoHydrated(page, '/projects/new');
  await page.getByLabel('Project name').fill('Not A Slug');
  await page.getByLabel('Description').fill('A todo list');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText(/lowercase letters/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Skill level' })).toBeHidden();
});

test('creates a project and follows it to its dashboard', async ({ page }) => {
  await mockAuth(page);

  let posted: unknown;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    posted = route.request().postDataJSON();
    // Simulate the round-trip so the progress checklist is observable.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 201, json: PROJECT });
  });
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));

  await gotoHydrated(page, '/projects/new');
  await page.getByLabel('Project name').fill('todo-app');
  await page.getByLabel('Description').fill('A todo list');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: 'Expert' }).check();
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByText('Creating GitHub repository')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
  expect(posted).toEqual({ name: 'todo-app', description: 'A todo list', skillLevel: 'expert' });
});

test('reports a provisioning failure and lets the Developer go back', async ({ page }) => {
  await mockAuth(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ status: 502, json: { error: 'repository', message: 'repo name is taken' } }),
  );

  await gotoHydrated(page, '/projects/new');
  await page.getByLabel('Project name').fill('todo-app');
  await page.getByLabel('Description').fill('A todo list');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('radio', { name: 'Beginner' }).check();
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('alert')).toHaveText('repo name is taken');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Project details' })).toBeVisible();
});
