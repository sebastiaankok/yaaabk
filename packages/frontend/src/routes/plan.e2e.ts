import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  skillLevel: 'expert',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
  lastModel: 'openrouter/chosen-model',
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
  draft: { hasPrd: true, issueCount: 1 },
};

const ISSUE = {
  id: 'i1',
  projectId: 'p1',
  planId: 'v1',
  githubNumber: null,
  githubSyncedAt: null,
  title: 'Save a bookmark',
  body: 'Persist a bookmark.',
  status: 'open',
  label: 'ready',
  dependsOn: [],
  attemptCount: 0,
  maxAttempts: 3,
  budgetCents: 50,
  openrouterKeyHash: null,
  closedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

interface MockOptions {
  activeSession?: typeof SESSION | null;
  startFailure?: string;
  /** The drafts the mocked session holds, defaulting to the complete SESSION. */
  draft?: { hasPrd: boolean; issueCount: number };
  issues?: (typeof ISSUE)[];
}

/** A signed-in session with a project, its plan and a scripted grill session API. */
async function mockProject(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/models', (route) =>
    route.fulfill({
      json: {
        models: [
          {
            id: 'openrouter/chosen-model',
            name: 'Chosen model',
            contextLength: 200000,
            promptUsdPerMillion: 3,
            completionUsdPerMillion: 15,
          },
          {
            id: 'openrouter/other-model',
            name: 'Other model',
            contextLength: 128000,
            promptUsdPerMillion: 1,
            completionUsdPerMillion: 2,
          },
        ],
        defaultModel: 'openrouter/default-model',
      },
    }),
  );
  await page.route('**/api/projects/p1/plans', (route) =>
    route.fulfill({ json: { plans: [PLAN] } }),
  );
  await page.route('**/api/projects/p1/plans/active', (route) => route.fulfill({ json: PLAN }));
  await page.route('**/api/projects/p1/issues', (route) =>
    route.fulfill({ json: { issues: options.issues ?? [] } }),
  );

  const draft = options.draft ?? SESSION.draft;
  let active =
    options.activeSession === null
      ? null
      : options.activeSession === undefined
        ? null
        : { ...SESSION, draft };
  await page.route('**/api/projects/p1/grill', async (route) => {
    if (route.request().method() === 'POST') {
      if (options.startFailure !== undefined) {
        await route.fulfill({
          status: 502,
          json: { error: 'start-failed', message: options.startFailure },
        });
        return;
      }
      active = { ...SESSION, draft };
      await route.fulfill({ status: 201, json: active });
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
      json: {
        ...SESSION,
        status: 'cancelled',
        endReason: 'cancelled',
        draft: { hasPrd: false, issueCount: 0 },
      },
    }),
  );
  await page.route('**/api/projects/p1/grill/s1/finish', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { force?: boolean };
    const missing = [...(draft.hasPrd ? [] : ['prd']), ...(draft.issueCount > 0 ? [] : ['issues'])];
    if (missing.length > 0 && body.force !== true) {
      await route.fulfill({
        status: 409,
        json: {
          error: 'incomplete',
          message: `Cannot finish: ${missing.map((item) => (item === 'prd' ? 'a PRD' : 'an issue list')).join(' and ')} missing`,
          missing,
        },
      });
      return;
    }
    active = null;
    await route.fulfill({
      json: {
        session: {
          ...SESSION,
          status: 'finished',
          endReason: 'finished',
          draft: { hasPrd: false, issueCount: 0 },
        },
        plan: { ...PLAN, contentMarkdown: '# Plan (PRD)' },
        issues: options.issues ?? [],
      },
    });
  });
}

interface TerminalMock {
  /** Input frames the browser sent over the terminal socket. */
  input: string[];
  /** How many terminal sockets the page opened. */
  connections: () => number;
  /** Pretends the backend closed the session. */
  close: () => void;
}

/** Mocks the backend terminal socket, marks the terminal live, and records typed input. */
async function mockTerminal(page: Page): Promise<TerminalMock> {
  const input: string[] = [];
  let connections = 0;
  let socketRef: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/grill\/s1\/terminal$/, (socket) => {
    connections += 1;
    socketRef = socket;
    socket.onMessage((message) => {
      if (typeof message !== 'string') return;
      try {
        const parsed = JSON.parse(message) as { type?: string; data?: string };
        if (parsed.type === 'input' && typeof parsed.data === 'string') input.push(parsed.data);
      } catch {
        // Ignore non-JSON frames from xterm.
      }
    });
    socket.send(JSON.stringify({ type: 'status', status: 'live' }));
  });
  return {
    input,
    connections: () => connections,
    close: () => socketRef?.send(JSON.stringify({ type: 'status', status: 'closed' })),
  };
}

test('shows the project and its active plan', async ({ page }) => {
  await mockProject(page);

  await page.goto('/projects/p1/plan');

  await expect(page.getByRole('heading', { name: 'todo-app' })).toBeVisible();
  await expect(page.getByText('A todo list')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan (PRD)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
});

test('preselects the Project model and starts the session with it', async ({ page }) => {
  await mockProject(page);
  await mockTerminal(page);
  let startedWith: string | undefined;
  await page.route('**/api/projects/p1/grill', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    startedWith = (route.request().postDataJSON() as { model?: string }).model;
    await route.fulfill({ status: 201, json: SESSION });
  });

  await page.goto('/projects/p1/plan');

  await expect(page.getByLabel('Model')).toHaveValue('openrouter/chosen-model');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect.poll(() => startedWith).toBe('openrouter/chosen-model');
});

test('starts a live terminal session and cancels it after confirmation', async ({ page }) => {
  await mockProject(page);
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
  expect(await page.locator('.xterm').count()).toBe(1);

  await page.getByRole('button', { name: 'Cancel session' }).click();
  await expect(page.getByText(/will be discarded/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard and cancel' }).click();

  await expect(page.getByText('Session cancelled.')).toBeVisible();
  await expect(page.getByLabel('Your idea')).toBeVisible();
});

test('keeps the session when the Developer dismisses the cancel confirmation', async ({ page }) => {
  await mockProject(page);
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await page.getByLabel('Your idea').fill('A todo app');
  await page.getByRole('button', { name: 'Start Grill-Me' }).click();

  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel session' }).click();
  await expect(page.getByText(/will be discarded/)).toBeVisible();

  await page.getByRole('button', { name: 'Keep session' }).click();

  await expect(page.getByText(/will be discarded/)).not.toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
  expect(await page.locator('.xterm').count()).toBe(1);
});

test('reconnects to a running session after a refresh', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');

  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
  await expect(page.getByText('PRD drafted · 1 issue drafted')).toBeVisible();
  expect(await page.locator('.xterm').count()).toBe(1);
});

test('expands the live terminal to a fullscreen overlay', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  const terminal = await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Expand terminal' }).click();

  const overlay = page.getByRole('region', { name: 'Fullscreen terminal' });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'Minimize terminal' })).toBeVisible();
  const statusDot = overlay.getByRole('status', { name: 'Live' });
  await expect(statusDot).toBeVisible();
  await expect(statusDot).toHaveClass(/bg-emerald-400/);

  // The same xterm instance stays mounted, so no reconnect or replay happened.
  expect(await page.locator('.xterm').count()).toBe(1);
  expect(terminal.connections()).toBe(1);
  const box = await overlay.boundingBox();
  const viewport = page.viewportSize();
  expect(box?.width).toBe(viewport?.width);
  expect(box?.height).toBe(viewport?.height);
});

test('collapses the fullscreen terminal back into the page', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  const terminal = await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand terminal' }).click();
  const overlay = page.getByRole('region', { name: 'Fullscreen terminal' });
  await expect(overlay).toBeVisible();

  await overlay.getByRole('button', { name: 'Minimize terminal' }).click();

  await expect(overlay).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand terminal' })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  expect(await page.locator('.xterm').count()).toBe(1);
  expect(terminal.connections()).toBe(1);
});

test('focuses the terminal when it expands', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  const { input } = await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Expand terminal' }).click();
  await expect(page.getByRole('region', { name: 'Fullscreen terminal' })).toBeVisible();

  await page.keyboard.type('answer');

  await expect.poll(() => input.join('')).toBe('answer');
});

test('leaves fullscreen automatically when the session closes', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  const terminal = await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand terminal' }).click();
  const overlay = page.getByRole('region', { name: 'Fullscreen terminal' });
  await expect(overlay).toBeVisible();

  terminal.close();

  await expect(overlay).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand terminal' })).toBeVisible();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
});

test('a refresh never lands in fullscreen', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION });
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand terminal' }).click();
  await expect(page.getByRole('region', { name: 'Fullscreen terminal' })).toBeVisible();

  await page.reload();

  await expect(page.getByRole('button', { name: 'Expand terminal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fullscreen terminal' })).toHaveCount(0);
});

test('finishes a session and shows the published Plan (PRD) and Issues', async ({ page }) => {
  await mockProject(page, { activeSession: SESSION, issues: [ISSUE] });
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();

  await expect(page.getByText('Published Plan (PRD) v1 and 1 issue.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan (PRD)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.getByText('Save a bookmark')).toBeVisible();
  await expect(page.getByLabel('Your idea')).toBeVisible();
});

test('warns before publishing an incomplete session and forces on request', async ({ page }) => {
  await mockProject(page, {
    activeSession: SESSION,
    draft: { hasPrd: true, issueCount: 0 },
  });
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();

  await expect(page.getByText('Cannot finish: an issue list missing')).toBeVisible();
  await page.getByRole('button', { name: 'Publish anyway' }).click();

  await expect(page.getByText(/Published Plan \(PRD\)/)).toBeVisible();
});

test('does not offer a forced publish when the PRD is missing', async ({ page }) => {
  await mockProject(page, {
    activeSession: SESSION,
    draft: { hasPrd: false, issueCount: 0 },
  });
  await mockTerminal(page);

  await page.goto('/projects/p1/plan');
  await page.getByRole('button', { name: 'Finish', exact: true }).click();

  await expect(page.getByText('Cannot finish: a PRD and an issue list missing')).toBeVisible();
  await expect(page.getByText(/PRD has not been drafted yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish anyway' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finish again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
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

  await expect(page.getByRole('heading', { name: 'Plan (PRD)' })).toBeVisible();
});
