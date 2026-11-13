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

const sse = (events: string[]): string => events.map((event) => `${event}\n\n`).join('');

/** A signed-in session with a project, its plan and a plan-less active endpoint. */
async function mockProject(page: Page): Promise<void> {
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
}

test('shows the project and its active plan', async ({ page }) => {
  await mockProject(page);

  await page.goto('/projects/p1/plan');

  await expect(page.getByRole('heading', { name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
});

test('streams a question and sends an answer', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/projects/p1/grill', (route) =>
    route.fulfill({ status: 201, json: { sessionId: 's1' } }),
  );
  await page.route('**/api/projects/p1/grill/s1/answer', (route) =>
    route.fulfill({ json: { ok: true } }),
  );

  let attempts = 0;
  await page.route(
    (url) => url.pathname === '/api/projects/p1/grill' && url.searchParams.has('sessionId'),
    async (route) => {
      attempts += 1;
      if (attempts > 1) {
        await route.abort();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sse([
          'event: token\ndata: {"sessionId":"s1","text":"Thinking"}',
          'event: question\ndata: {"sessionId":"s1","question":"Which database?"}',
        ]),
      });
    },
  );

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByText('AI is thinking…')).toBeVisible();
  await expect(page.getByText('Which database?')).toBeVisible();
  await page.getByLabel('Your answer').fill('Postgres');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Postgres')).toBeVisible();
});

test('shows the plan when the session ends', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/projects/p1/grill', (route) =>
    route.fulfill({ status: 201, json: { sessionId: 's1' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/projects/p1/grill' && url.searchParams.has('sessionId'),
    (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sse([
          'event: question\ndata: {"sessionId":"s1","question":"Which database?"}',
          'event: plan_ready\ndata: {"sessionId":"s1","plan":"# Refined plan"}',
          'event: ended\ndata: {"sessionId":"s1","reason":"completed"}',
        ]),
      }),
  );

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByRole('heading', { name: 'Refined plan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a new session' })).toBeVisible();
});

test('cancels the session', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/projects/p1/grill', (route) =>
    route.fulfill({ status: 201, json: { sessionId: 's1' } }),
  );
  await page.route('**/api/projects/p1/grill/s1/cancel', (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route(
    (url) => url.pathname === '/api/projects/p1/grill' && url.searchParams.has('sessionId'),
    (route) =>
      route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }),
  );

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();
  await page.getByRole('button', { name: 'Cancel session' }).click();

  await expect(page.getByText('Session cancelled')).toBeVisible();
});

test('reconnects after the SSE stream drops', async ({ page }) => {
  await mockProject(page);
  await page.route('**/api/projects/p1/grill', (route) =>
    route.fulfill({ status: 201, json: { sessionId: 's1' } }),
  );

  let attempts = 0;
  await page.route(
    (url) => url.pathname === '/api/projects/p1/grill' && url.searchParams.has('sessionId'),
    async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sse([
          'event: question\ndata: {"sessionId":"s1","question":"Which database?"}',
          'event: ended\ndata: {"sessionId":"s1","reason":"cancelled"}',
        ]),
      });
    },
  );

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await expect(page.getByText('Which database?')).toBeVisible();
  await expect(page.getByText('Reconnecting…')).toBeHidden();
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
