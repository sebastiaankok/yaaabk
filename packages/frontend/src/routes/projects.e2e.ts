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

/** A signed-in session. */
async function mockAuth(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
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
  await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: [PROJECT] } }));

  await gotoHydrated(page, '/');

  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  await expect(page.getByText('expert')).toBeVisible();
  await expect(page.getByText('project-a1b2c3d4')).toBeVisible();
});

test('invites the Developer to create the first project when there are none', async ({ page }) => {
  await mockAuth(page);
  await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: [] } }));

  await gotoHydrated(page, '/');

  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first project' })).toBeVisible();
});

test('surfaces a loading, then a failure state', async ({ page }) => {
  await mockAuth(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ status: 502, json: { error: 'kubernetes', message: 'cluster unreachable' } }),
  );

  await gotoHydrated(page, '/');

  await expect(page.getByRole('alert')).toHaveText('cluster unreachable');
});

test('opens a project dashboard from the list', async ({ page }) => {
  await mockAuth(page);
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: [PROJECT] } }));

  await gotoHydrated(page, '/');
  await page.getByRole('link', { name: 'todo-app' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
});
