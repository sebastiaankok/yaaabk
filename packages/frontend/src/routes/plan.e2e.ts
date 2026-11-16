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

const PLAN = {
  id: 'v1',
  projectId: 'p1',
  version: 1,
  contentMarkdown: '# Plan',
  skillLevel: 'expert',
  source: 'grill-me',
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
};

const SESSION = {
  id: 's1',
  projectId: 'p1',
  status: 'active',
  skillLevel: 'expert',
  model: 'openrouter/default-model',
  startedAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  endReason: null,
  error: null,
  terminalPath: '/api/projects/p1/grill/s1/terminal',
};

interface MockOptions {
  activeSession?: typeof SESSION | null;
  startFailure?: string;
}

/** A signed-in session with a project, its plan and a scripted grill session API. */
async function mockProject(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects/p1/plans', (route) =>
    route.fulfill({ json: { plans: [PLAN] } }),
  );
  await page.route('**/api/projects/p1/plans/active', (route) => route.fulfill({ json: PLAN }));

  let active = options.activeSession ?? null;
  await page.route('**/api/projects/p1/grill', async (route) => {
    if (route.request().method() === 'POST') {
      if (options.startFailure !== undefined) {
        await route.fulfill({
          status: 502,
          json: { error: 'start-failed', message: options.startFailure },
        });
        return;
      }
      active = SESSION;
      await route.fulfill({ status: 201, json: SESSION });
      return;
    }
    await route.fulfill(
      active === null
        ? { status: 404, json: { error: 'not-found', message: 'No active grill session' } }
        : { json: active },
    );
  });
  await page.route('**/api/projects/p1/grill/s1/cancel', (route) =>
    route.fulfill({
      json: { ...SESSION, status: 'cancelled', endReason: 'cancelled' },
    }),
  );
}

/** Mocks the backend terminal socket and immediately marks the terminal live. */
async function mockTerminal(page: Page): Promise<void> {
  await page.routeWebSocket(/\/grill\/s1\/terminal$/, (socket) => {
    socket.send(JSON.stringify({ type: 'status', status: 'live' }));
  });
}

test('shows the project and its active plan', async ({ page }) => {
  await mockProject(page);

  await page.goto('/projects/p1/plan');

  await expect(page.getByRole('heading', { name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
});

test('starts a live terminal session and cancels it', async ({ page }) => {
  await mockProject(page);
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
  expect(await page.locator('.xterm').count()).toBe(1);

  await page.getByRole('button', { name: 'Cancel session' }).click();

  await expect(page.getByText('Session cancelled.')).toBeVisible();
  await expect(page.getByLabel('Your idea')).toBeVisible();
});

test('reconnects to a running session after a refresh', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');

  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
  expect(await page.locator('.xterm').count()).toBe(1);
});

test('shows the reason a session could not start', async ({ page }) => {
  await mockProject(page, { startFailure: 'ttyd: exec format error' });

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByText('ttyd: exec format error')).toBeVisible();
  await expect(page.getByLabel('Your idea')).toBeVisible();
});

test('activates an earlier plan version', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/projects/p1/plans', (route) =>
    route.fulfill({
      json: {
        plans: [
          { ...PLAN, id: 'v2', version: 2, isActive: true, contentMarkdown: '# Plan v2' },
          { ...PLAN, id: 'v1', version: 1, isActive: false, contentMarkdown: '# Plan v1' },
        ],
      },
    }),
  );
  await page.route('**/api/projects/p1/plans/active', (route) =>
    route.fulfill({
      json: { ...PLAN, id: 'v2', version: 2, isActive: true, contentMarkdown: '# Plan v2' },
    }),
  );
  await page.route('**/api/projects/p1/plans/v1/activate', (route) =>
    route.fulfill({ json: { ...PLAN, id: 'v1', version: 1, isActive: true } }),
  );

  await page.goto('/projects/p1/plan');
  await page.getByRole('button', { name: 'Activate' }).click();

  await expect(page.getByRole('heading', { name: 'Active plan' })).toBeVisible();
});
