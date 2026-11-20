import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const PROVISIONING_STEPS = ['repository', 'scaffold', 'namespace', 'rbac', 'persist'] as const;

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

async function fillDetails(page: Page): Promise<void> {
  await page.getByLabel('Project name').fill('todo-app');
  await page.getByLabel('Description').fill('A todo list');
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

/** One real Server-Sent Event frame. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A throwaway SSE endpoint that spaces provisioning frames out in real time.
 *
 * Playwright's `route.fulfill` delivers a body all at once, which Svelte batches
 * into a single render, so the checklist would never be observed moving from
 * running to done. This server lets the spec follow each transition.
 */
async function startProvisioningServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const frames = PROVISIONING_STEPS.flatMap((step) => [
    sseFrame('progress', { step, status: 'started' }),
    sseFrame('progress', { step, status: 'completed' }),
  ]);
  frames.push(sseFrame('done', PROJECT));

  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type, accept');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api/projects') {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let index = 0;
    const timer = setInterval(() => {
      const frame = frames[index];
      if (frame === undefined) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(frame);
      index += 1;
    }, 120);
    request.on('close', () => clearInterval(timer));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/api/projects`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test('announces the current wizard step without relying on colour', async ({ page }) => {
  await mockAuth(page);

  await gotoHydrated(page, '/projects/new');

  const detailsStep = page.getByTestId('wizard-step-details');
  const modeStep = page.getByTestId('wizard-step-mode');
  await expect(detailsStep).toHaveAttribute('aria-current', 'step');
  await expect(detailsStep).toContainText('Current');
  await expect(modeStep).not.toHaveAttribute('aria-current');
  await expect(modeStep).toContainText('Next');

  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(modeStep).toHaveAttribute('aria-current', 'step');
  await expect(modeStep).toContainText('Current');
  await expect(detailsStep).not.toHaveAttribute('aria-current');
  await expect(detailsStep).toContainText('Completed');
});

test('ties each invalid field to its own inline message', async ({ page }) => {
  await mockAuth(page);

  await gotoHydrated(page, '/projects/new');
  const name = page.getByLabel('Project name');
  const description = page.getByLabel('Description');

  await name.fill('Not A Slug');
  await description.fill('A todo list');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAttribute('aria-describedby', 'name-error');
  await expect(page.locator('#name-error')).toHaveText(/lowercase letters/);
  await expect(page.getByTestId('wizard-step-details')).toHaveAttribute('aria-current', 'step');

  await name.fill('todo-app');
  await description.fill('');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(description).toHaveAttribute('aria-invalid', 'true');
  await expect(description).toHaveAttribute('aria-describedby', 'description-error');
  await expect(page.locator('#description-error')).toHaveText('A description is required');
  await expect(
    page.getByRole('heading', { name: 'How should the agent work with you?' }),
  ).toBeHidden();
});

test('going back from Mode preserves both fields', async ({ page }) => {
  await mockAuth(page);

  await gotoHydrated(page, '/projects/new');
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Back' }).click();

  await expect(page.getByLabel('Project name')).toHaveValue('todo-app');
  await expect(page.getByLabel('Description')).toHaveValue('A todo list');
  await expect(page.getByTestId('wizard-step-details')).toHaveAttribute('aria-current', 'step');
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
    // Stream real progress frames before finishing, mimicking the backend.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frames = [
      'event: progress\ndata: {"step":"repository","status":"started"}\n\n',
      'event: progress\ndata: {"step":"repository","status":"completed"}\n\n',
      `event: done\ndata: ${JSON.stringify(PROJECT)}\n\n`,
    ].join('');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames,
    });
  });
  await page.route('**/api/projects/p1/overview', (route) =>
    route.fulfill({
      json: {
        project: PROJECT,
        activePlan: null,
        activeWork: [],
        issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
        lastRunAt: null,
      },
    }),
  );

  await gotoHydrated(page, '/projects/new');
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('radio', { name: 'Guided' })).toBeChecked();
  await expect(
    page.getByText(
      'The agent interviews you one question at a time, then checks the module sketch and issue breakdown with you.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The agent decides everything itself and only shows you the finished Plan and Issues.',
    ),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Autonomous' }).check();
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByText('Creating GitHub repository')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
  expect(posted).toEqual({ name: 'todo-app', description: 'A todo list', mode: 'autonomous' });
});

test('moves every provisioning step from running to done', async ({ page }) => {
  await mockAuth(page);
  const stream = await startProvisioningServer();
  await page.route('http://localhost:3000/api/projects', (route) =>
    route.request().method() === 'POST' ? route.continue({ url: stream.url }) : route.fallback(),
  );
  await page.route('**/api/projects/p1/overview', (route) =>
    route.fulfill({
      json: {
        project: PROJECT,
        activePlan: null,
        activeWork: [],
        issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
        lastRunAt: null,
      },
    }),
  );

  try {
    await gotoHydrated(page, '/projects/new');
    await fillDetails(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();

    const repository = page.getByTestId('provisioning-repository');
    await expect(repository).toHaveAttribute('data-status', 'active');
    await expect(repository.getByText('Running')).toBeVisible();
    await expect(repository).toHaveAttribute('data-status', 'done');

    for (const step of PROVISIONING_STEPS) {
      await expect(page.getByTestId(`provisioning-${step}`)).toHaveAttribute('data-status', 'done');
    }

    await expect(page.getByRole('heading', { level: 1, name: 'todo-app' })).toBeVisible();
  } finally {
    await stream.close();
  }
});

test('reports a provisioning failure and lets the Developer retry from the details', async ({
  page,
}) => {
  await mockAuth(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ status: 502, json: { error: 'repository', message: 'repo name is taken' } }),
  );

  await gotoHydrated(page, '/projects/new');
  await fillDetails(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not finish provisioning');
  await expect(alert).toContainText('repo name is taken');
  await expect(page.getByTestId('provisioning-repository')).toHaveAttribute(
    'data-status',
    'failed',
  );

  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Project details' })).toBeVisible();
  await expect(page.getByTestId('wizard-step-details')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByLabel('Project name')).toHaveValue('todo-app');
  await expect(page.getByLabel('Description')).toHaveValue('A todo list');
});

test('keeps the wizard actions full-width and 44px tall at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockAuth(page);

  await gotoHydrated(page, '/projects/new');
  await expectNoHorizontalOverflow(page);

  const nameBox = await page.getByLabel('Project name').boundingBox();
  expect(nameBox).not.toBeNull();
  expect(nameBox!.height).toBeGreaterThanOrEqual(44);

  const continueButton = page.getByRole('button', { name: 'Continue' });
  const continueBox = await continueButton.boundingBox();
  expect(continueBox).not.toBeNull();
  expect(continueBox!.height).toBeGreaterThanOrEqual(44);
  expect(continueBox!.width).toBeCloseTo(nameBox!.width, 0);

  await fillDetails(page);
  await continueButton.click();
  await expectNoHorizontalOverflow(page);

  for (const name of ['Back', 'Create project']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeCloseTo(nameBox!.width, 0);
  }
});
