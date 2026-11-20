import { expect, test, type Locator, type Page } from '@playwright/test';
import type { IssueGraph } from '@yaaabk/issues';

const PROJECT = {
  id: 'p1',
  name: 'todo-app',
  description: 'A todo list',
  skillLevel: 'expert',
  repoUrl: 'https://github.com/acme/todo-app',
  repoFullName: 'acme/todo-app',
  namespace: 'yaaabk-a1b2c3d4',
  agentModel: null,
  deployedCommitSha: null,
  lastDeployStatus: null,
  lastDeployAt: null,
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

function issue(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'i1',
    projectId: 'p1',
    planId: 'v1',
    githubNumber: null,
    githubSyncedAt: null,
    body: '',
    summary: null,
    status: 'open',
    label: 'ready',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 50,
    openrouterKeyHash: null,
    agentModel: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const READY = issue({
  id: 'i1',
  title: 'Schema',
  label: 'ready',
  body: 'Create the tables',
  summary: 'Create the bookmark tables.',
});
const BLOCKED = issue({
  id: 'i2',
  title: 'Api',
  label: 'blocked',
  dependsOn: ['Schema'],
  summary: 'Expose the bookmark endpoints.',
});
const ACTIVE = issue({
  id: 'i3',
  title: 'Auth',
  status: 'in_progress',
  summary: 'Add sign-in and session handling.',
  attemptCount: 1,
  createdAt: '2026-01-02T00:00:00.000Z',
});
const CLOSED = issue({
  id: 'i4',
  title: 'Scaffold',
  status: 'closed',
  summary: 'Create the project skeleton.',
  createdAt: '2026-01-03T00:00:00.000Z',
});
const FAILED = issue({
  id: 'i5',
  title: 'Deploy',
  status: 'failed',
  label: 'needs-human',
  summary: 'Deploy the project to Kubernetes.',
  createdAt: '2026-01-04T00:00:00.000Z',
});

const RUNNING = {
  id: 'r-live',
  issueId: 'i1',
  attemptNumber: 2,
  status: 'running',
  prUrl: null,
  costCents: 0,
  model: null,
  logs: null,
  startedAt: '2026-01-01T00:10:00.000Z',
  finishedAt: null,
};

const GRAPH: IssueGraph = {
  nodes: [
    { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: 0 },
    { id: 'i2', title: 'Api', dependsOn: ['i1'], missing: [], wave: 1 },
    { id: 'i3', title: 'Auth', dependsOn: [], missing: [], wave: 0 },
    { id: 'i4', title: 'Scaffold', dependsOn: [], missing: [], wave: 0 },
    { id: 'i5', title: 'Deploy', dependsOn: ['i2'], missing: [], wave: 2 },
  ],
  cycles: [],
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
  acceptedAt: null,
};

interface Mocks {
  plans: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  graph: IssueGraph;
  runs: Record<string, unknown>[];
  budgets: Record<string, Record<string, unknown>>;
}

/** Mocks the project and the endpoints the board reads on load. */
async function mockBoard(page: Page): Promise<Mocks> {
  const state: Mocks = {
    plans: [PLAN],
    issues: [READY, BLOCKED, ACTIVE, CLOSED, FAILED],
    graph: GRAPH,
    budgets: {
      i1: {
        issueId: 'i1',
        budgetCents: 50,
        spentCents: 20,
        remainingCents: 30,
        keyOpen: true,
        exhausted: false,
      },
    },
    runs: [
      {
        id: 'r1',
        issueId: 'i1',
        attemptNumber: 1,
        status: 'success',
        prUrl: 'https://github.com/acme/todo-app/pull/1',
        costCents: 10,
        model: 'openrouter/default-model',
        logs: 'Agent finished: opened PR #1',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:05:00.000Z',
      },
    ],
  };

  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects/p1/issues', (route) =>
    route.fulfill({ json: { issues: state.issues } }),
  );
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: state.graph }),
  );
  await page.route('**/api/projects/p1/issues/*/budget', (route) => {
    const segments = new URL(route.request().url()).pathname.split('/');
    const id = segments[segments.length - 2] ?? '';
    const budget = state.budgets[id];
    return budget === undefined
      ? route.fulfill({ json: { error: 'not-found', message: 'no budget' }, status: 404 })
      : route.fulfill({ json: budget });
  });
  await page.route('**/api/projects/p1/plans/active', (route) =>
    route.fulfill({ json: state.plans[0] }),
  );
  await page.route('**/api/projects/p1/agent-runs', (route) =>
    route.fulfill({ json: { runs: state.runs } }),
  );
  await page.route('**/api/models', (route) => route.fulfill({ json: MODELS }));
  return state;
}

/** The board card for an issue title, matched by the start of its accessible name. */
function card(page: Page, title: string) {
  return page.getByRole('button', { name: new RegExp(`^${title} `) });
}

/**
 * Replaces the agent-log endpoint with an event stream the test feeds one chunk
 * at a time, so it can append output while the drawer stays open.
 */
async function mockLiveAgentLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const agentLog = {
      push(chunk: string) {
        const frame = `event: log\ndata: ${JSON.stringify({ chunk })}\n\n`;
        for (const controller of controllers) controller.enqueue(encoder.encode(frame));
      },
    };
    (window as unknown as { __agentLog: typeof agentLog }).__agentLog = agentLog;

    window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      if (!/^\/api\/projects\/[^/]+\/agent-runs\/[^/]+\/logs$/.test(url.pathname)) {
        return originalFetch(input, init);
      }
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(next) {
          controller = next;
          controllers.push(next);
        },
      });
      init?.signal?.addEventListener('abort', () => {
        if (controller === null) return;
        const index = controllers.indexOf(controller);
        if (index !== -1) controllers.splice(index, 1);
        try {
          controller.close();
        } catch {
          // The stream already finished; there is nothing left to close.
        }
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }) as typeof fetch;
  });
}

/** Appends a chunk to every open live agent log. */
async function pushAgentLog(page: Page, chunk: string): Promise<void> {
  await page.evaluate((text) => {
    (window as unknown as { __agentLog: { push(chunk: string): void } }).__agentLog.push(text);
  }, chunk);
}

/** Numbered lines, enough of them to overflow the live output panel. */
function numberedLines(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`).join('\n');
}

/** Whether a scroll box is showing its last pixel. */
async function isAtBottom(scroller: Locator): Promise<boolean> {
  return scroller.evaluate((element) => {
    const box = element as HTMLElement;
    return box.scrollHeight - box.scrollTop - box.clientHeight <= 1;
  });
}

test('groups issues into their lanes with labels and waves', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Blocked' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In Progress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Failed' })).toBeVisible();

  const ready = page.getByRole('region', { name: 'Ready' });
  await expect(ready.getByText('Schema')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Blocked' }).getByText('Api')).toBeVisible();
  await expect(page.getByRole('region', { name: 'In Progress' }).getByText('Auth')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Failed' }).getByText('Deploy', { exact: true }),
  ).toBeVisible();
  await expect(ready.getByText('Wave 0')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Failed' }).getByText('Wave 2')).toBeVisible();
});

test('previews the issue summary on the card and the full body in the drawer', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  const schema = card(page, 'Schema');
  await expect(schema.getByText('Create the bookmark tables.')).toBeVisible();
  await schema.click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('Create the tables')).toBeVisible();
});

test('hides closed issues until the history is asked for', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await expect(page.getByRole('heading', { name: 'Closed' })).toHaveCount(0);
  await expect(card(page, 'Scaffold')).toHaveCount(0);

  await page.getByLabel('Show closed issues').check();

  await expect(page.getByRole('heading', { name: 'Closed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Closed' }).getByText('Scaffold')).toBeVisible();
});

test('follows the active plan until earlier plans are shown', async ({ page }) => {
  const state = await mockBoard(page);
  state.issues = [
    ...state.issues,
    issue({
      id: 'i6',
      title: 'Legacy',
      planId: 'v0',
      createdAt: '2026-01-05T00:00:00.000Z',
    }),
  ];
  state.graph = {
    nodes: [
      ...state.graph.nodes,
      { id: 'i6', title: 'Legacy', dependsOn: [], missing: [], wave: 0 },
    ],
    cycles: [],
  };

  await page.goto('/projects/p1/issues');

  await expect(card(page, 'Legacy')).toHaveCount(0);
  await expect(page.getByText('1 open issue belongs to an earlier Plan')).toBeVisible();

  await page.getByLabel('Show earlier plans').check();

  await expect(card(page, 'Legacy')).toBeVisible();
  await expect(page.getByText('1 open issue belongs to an earlier Plan')).toHaveCount(0);
});

test('flags the active plan as not accepted and links to review', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  const chip = page.getByRole('link', { name: 'not accepted' });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('href', '/projects/p1/issues/review');

  await page.getByLabel('Show earlier plans').check();

  await expect(page.getByRole('link', { name: 'Plan v1 not accepted' })).toHaveAttribute(
    'href',
    '/projects/p1/issues/review',
  );
});

test('shows no not-accepted chip once the active plan is accepted', async ({ page }) => {
  const state = await mockBoard(page);
  state.plans = [{ ...PLAN, acceptedAt: '2026-01-02T00:00:00.000Z' }];

  await page.goto('/projects/p1/issues');

  await expect(page.getByText('Showing Plan v1.')).toBeVisible();
  await expect(page.getByRole('link', { name: /not accepted/ })).toHaveCount(0);
});

test('banners a matching accepted plan once the board opens', async ({ page }) => {
  const state = await mockBoard(page);
  state.plans = [{ ...PLAN, acceptedAt: '2026-01-02T00:00:00.000Z' }];

  await page.goto('/projects/p1/issues?accepted=1');

  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toBeVisible();
  await expect(page).not.toHaveURL(/accepted=/);
});

test('dismisses the acceptance banner', async ({ page }) => {
  const state = await mockBoard(page);
  state.plans = [{ ...PLAN, acceptedAt: '2026-01-02T00:00:00.000Z' }];

  await page.goto('/projects/p1/issues?accepted=1');
  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss' }).click();

  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toHaveCount(0);
});

test('does not banner again after reloading the board', async ({ page }) => {
  const state = await mockBoard(page);
  state.plans = [{ ...PLAN, acceptedAt: '2026-01-02T00:00:00.000Z' }];

  await page.goto('/projects/p1/issues?accepted=1');
  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toBeVisible();

  await page.reload();

  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toHaveCount(0);
  await expect(page).not.toHaveURL(/accepted=/);
});

test('ignores an accepted version that is not the active accepted plan', async ({ page }) => {
  const state = await mockBoard(page);
  state.plans = [{ ...PLAN, version: 2, acceptedAt: '2026-01-02T00:00:00.000Z' }];

  await page.goto('/projects/p1/issues?accepted=1');

  await expect(page.getByText(/accepted and synced to GitHub/)).toHaveCount(0);
  await expect(page).not.toHaveURL(/accepted=/);

  state.plans = [PLAN];
  await page.goto('/projects/p1/issues?accepted=1');

  await expect(page.getByText(/accepted and synced to GitHub/)).toHaveCount(0);
});

test('opens the issue named in the URL once the issues load', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues?issue=i1');

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Create the tables')).toBeVisible();
});

test('ignores an unknown issue id in the URL and clears it', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues?issue=missing');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/issue=/);
});

test('clears the issue parameter when the drawer closes', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues?issue=i1');
  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel).toBeVisible();

  await panel.getByRole('button', { name: 'Close details' }).click();

  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/issue=/);
});

test('draws dependency arrows between cards', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await expect(page.locator('[data-edge="i1->i2"]')).toHaveCount(1);
  await expect(page.locator('[data-edge="i2->i5"]')).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Blocked' }).getByText('Depends on: Schema'),
  ).toBeVisible();
});

test('filters the cards by text, label, lane and wave', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');

  await page.getByLabel('Search issues').fill('auth');
  await expect(card(page, 'Auth')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();

  await page.getByLabel('Search issues').fill('bookmark endpoints');
  await expect(card(page, 'Api')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();

  await page.getByLabel('Search issues').fill('');
  await page.getByLabel('Filter by label').selectOption('blocked');
  await expect(card(page, 'Api')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();
  await page.getByLabel('Filter by label').selectOption('');

  await page.getByLabel('Filter by wave').selectOption('2');
  await expect(card(page, 'Deploy')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();
  await page.getByLabel('Filter by wave').selectOption('');

  await page.getByLabel('Filter by lane').selectOption('failed');
  await expect(card(page, 'Deploy')).toBeVisible();
  await expect(card(page, 'Schema')).toBeHidden();
});

test('opens a card to show its body and agent run history', async ({ page }) => {
  await mockBoard(page);

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('Create the tables')).toBeVisible();
  await expect(panel.getByText('Attempt 1')).toBeVisible();
  await expect(panel.getByText('success')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'PR #1' })).toHaveAttribute(
    'href',
    'https://github.com/acme/todo-app/pull/1',
  );
  await panel.getByText('Logs').click();
  await expect(panel.getByText('Agent finished: opened PR #1')).toBeVisible();
});

test('shows measured token usage with a partial total and per-run values', async ({ page }) => {
  const state = await mockBoard(page);
  state.runs = [
    {
      ...state.runs[0],
      attemptNumber: 1,
      tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 4_000, write: 10 } },
    },
    {
      ...state.runs[0],
      id: 'r2',
      attemptNumber: 2,
      status: 'failed',
      prUrl: null,
      costCents: 0,
      tokens: null,
    },
  ];

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByTestId('issue-tokens')).toHaveText('Total: ≥ 5,260');
  await expect(panel.getByTestId('issue-token-breakdown')).toHaveText(
    'in 1,000 · out 250 · cached 4,010',
  );
  await expect(panel.getByTestId('run-tokens').nth(0)).toHaveText('Tokens: 5.3k');
  await expect(panel.getByTestId('run-tokens').nth(1)).toHaveText('Tokens: —');
  await expect(panel.getByText('Some model runs did not report token usage.')).toBeVisible();
});

test('renders Issue Markdown in the drawer', async ({ page }) => {
  const state = await mockBoard(page);
  state.issues = state.issues.map((item) =>
    item.id === 'i1' ? { ...item, body: '## Context\n\n- Create the tables\n- Add indexes' } : item,
  );

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByRole('heading', { level: 2, name: 'Context' })).toBeVisible();
  await expect(panel.locator('.prose ul li')).toHaveCount(2);
});

test('renders agent review Markdown in the drawer', async ({ page }) => {
  const state = await mockBoard(page);
  state.runs = [
    ...state.runs,
    {
      id: 'r-review',
      issueId: 'i1',
      kind: 'review',
      attemptNumber: 2,
      pullNumber: 1,
      status: 'success',
      prUrl: 'https://github.com/acme/todo-app/pull/1',
      costCents: 4,
      model: 'openrouter/default-model',
      reviewVerdict: 'request-changes',
      reviewBody: '### Findings\n\n- Return 404 for unknown `/api/*` routes.',
      logs: 'Reviewed the diff.',
      startedAt: '2026-01-01T00:10:00.000Z',
      finishedAt: '2026-01-01T00:12:00.000Z',
    },
  ];

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByRole('heading', { level: 3, name: 'Findings' })).toBeVisible();
  await expect(panel.locator('.prose ul li')).toHaveCount(1);
});

test('shows the budget, spend, remainder and raises the budget', async ({ page }) => {
  const state = await mockBoard(page);
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/projects/p1/issues/i1', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    patches.push(patch);
    const updated = {
      ...state.issues.find((item) => item.id === 'i1'),
      ...patch,
    };
    state.issues = state.issues.map((item) => (item.id === 'i1' ? updated : item));
    const budget = state.budgets.i1;
    if (budget !== undefined && typeof patch.budgetCents === 'number') {
      state.budgets.i1 = {
        ...budget,
        budgetCents: patch.budgetCents,
        remainingCents: Math.max(
          0,
          patch.budgetCents - (typeof budget.spentCents === 'number' ? budget.spentCents : 0),
        ),
      };
    }
    await route.fulfill({ json: updated });
  });

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('$0.50', { exact: true })).toBeVisible();
  await expect(panel.getByText('$0.20', { exact: true })).toBeVisible();
  await expect(panel.getByText('$0.30', { exact: true })).toBeVisible();

  await panel.getByRole('button', { name: 'Edit' }).click();
  await panel.getByLabel('Issue budget (USD)').fill('2.00');
  await panel.getByRole('button', { name: 'Save' }).click();

  await expect
    .poll(() => patches)
    .toEqual([
      {
        title: 'Schema',
        body: 'Create the tables',
        summary: 'Create the bookmark tables.',
        budgetCents: 200,
      },
    ]);
  await expect(panel.getByText('$2.00', { exact: true })).toBeVisible();
  await expect(panel.getByText('$1.80', { exact: true })).toBeVisible();
});

test('shows a review verdict and its written summary', async ({ page }) => {
  const state = await mockBoard(page);
  state.runs = [
    ...state.runs,
    {
      id: 'r-review',
      issueId: 'i1',
      kind: 'review',
      attemptNumber: 2,
      pullNumber: 1,
      status: 'success',
      prUrl: 'https://github.com/acme/todo-app/pull/1',
      costCents: 4,
      model: 'openrouter/default-model',
      reviewVerdict: 'request-changes',
      reviewBody: 'Return JSON 404 for unknown `/api/*` routes.',
      logs: 'Reviewed the diff.',
      startedAt: '2026-01-01T00:10:00.000Z',
      finishedAt: '2026-01-01T00:12:00.000Z',
    },
  ];

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('Review 2')).toBeVisible();
  await expect(panel.getByText('changes requested')).toBeVisible();
  await expect(panel.getByText('Return JSON 404 for unknown')).toBeVisible();
});

test('re-runs an agent for the open issue', async ({ page }) => {
  const state = await mockBoard(page);
  await page.route('**/api/projects/p1/issues/i1/spawn', (route) => {
    const run = {
      id: 'r2',
      issueId: 'i1',
      attemptNumber: 2,
      status: 'queued',
      prUrl: null,
      costCents: 0,
      logs: null,
      startedAt: null,
      finishedAt: null,
    };
    state.runs = [...state.runs, run];
    return route.fulfill({ json: run, status: 202 });
  });

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();
  await page.getByRole('button', { name: 'Re-run' }).click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  await expect(panel.getByText('Attempt 2')).toBeVisible();
  await expect(panel.getByText('queued')).toBeVisible();
});

test('shows why a re-run was refused when the budget cannot cover a reply', async ({ page }) => {
  await mockBoard(page);
  await page.route('**/api/projects/p1/issues/i1/spawn', (route) =>
    route.fulfill({
      status: 402,
      json: {
        error: 'budget-exhausted',
        message:
          '$0.30 remains of Issue Schema’s $0.50 budget after $0.20 spent, but the model can reserve up to $0.96 for one reply. Raise the Issue’s budget to at least $1.16 or choose a cheaper model.',
      },
    }),
  );

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();
  const panel = page.getByRole('dialog', { name: 'Schema' });
  await panel.getByRole('button', { name: 'Re-run' }).click();

  await expect(panel.getByRole('alert')).toContainText('$0.30 remains');
  await expect(panel.getByRole('alert')).toContainText('Raise the Issue’s budget');
});

test('saves and clears the issue agent model override', async ({ page }) => {
  const state = await mockBoard(page);
  const patches: unknown[] = [];
  await page.route('**/api/projects/p1/issues/i1', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    patches.push(patch);
    const updated = { ...state.issues.find((item) => item.id === 'i1'), ...patch };
    state.issues = state.issues.map((item) => (item.id === 'i1' ? updated : item));
    await route.fulfill({ json: updated });
  });

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  const select = panel.getByLabel('Agent model');
  await expect(select).toHaveValue('');
  await expect(panel.getByText('Model: openrouter/default-model')).toBeVisible();
  await expect(select.locator('option[value=""]')).toHaveText(
    'Use project default (openrouter/default-model)',
  );

  await select.selectOption('openrouter/chosen');
  await expect(panel.getByText('Runs use openrouter/chosen.')).toBeVisible();
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible();

  await select.selectOption('');
  await expect(panel.getByText('Runs use openrouter/default-model.')).toBeVisible();
  await expect
    .poll(() => patches)
    .toEqual([{ agentModel: 'openrouter/chosen' }, { agentModel: null }]);
});

test('edits and deletes the open issue', async ({ page }) => {
  const state = await mockBoard(page);
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/projects/p1/issues/i1', (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON() as Record<string, unknown>);
      state.issues = state.issues.map((item) =>
        item.id === 'i1' ? { ...item, title: 'Schema v2' } : item,
      );
      return route.fulfill({ json: state.issues.find((item) => item.id === 'i1') });
    }
    if (route.request().method() === 'DELETE') {
      state.issues = state.issues.filter((item) => item.id !== 'i1');
      state.graph = { nodes: state.graph.nodes.filter((node) => node.id !== 'i1'), cycles: [] };
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Issue title').fill('Schema v2');
  await page.getByLabel('Issue summary').fill('Create the bookmark tables and indexes.');
  await page.getByRole('button', { name: 'Save' }).click();

  const panel = page.getByRole('dialog', { name: 'Schema v2' });
  await expect(panel).toBeVisible();
  await expect(card(page, 'Schema v2')).toBeVisible();
  expect(patches[0]).toMatchObject({
    title: 'Schema v2',
    summary: 'Create the bookmark tables and indexes.',
  });

  await panel.getByRole('button', { name: 'Delete' }).click();
  await panel.getByRole('button', { name: 'Confirm delete' }).click();

  await expect(panel).toBeHidden();
  await expect(card(page, 'Schema v2')).toBeHidden();
});

test('follows live agent output while the reader is at the bottom', async ({ page }) => {
  const state = await mockBoard(page);
  state.runs = [...state.runs, RUNNING];
  await mockLiveAgentLog(page);

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  const live = panel.getByTestId('live-agent-log');
  await expect(live).toBeVisible();

  await pushAgentLog(page, numberedLines(1, 80));

  await expect(live).toContainText('line 80');
  await expect.poll(() => isAtBottom(live)).toBe(true);
});

test('pauses following when the reader scrolls up and resumes at the bottom', async ({ page }) => {
  const state = await mockBoard(page);
  state.runs = [...state.runs, RUNNING];
  await mockLiveAgentLog(page);

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  const live = panel.getByTestId('live-agent-log');
  const jump = panel.getByRole('button', { name: 'Jump to latest' });

  await pushAgentLog(page, numberedLines(1, 80));
  await expect(live).toContainText('line 80');
  await expect(jump).toHaveCount(0);

  await live.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(jump).toBeVisible();
  await expect.poll(() => isAtBottom(live)).toBe(false);

  await pushAgentLog(page, `\n${numberedLines(81, 160)}`);
  await expect(live).toContainText('line 160');
  await expect.poll(() => isAtBottom(live)).toBe(false);

  // Reaching the bottom by hand is enough to start following again.
  await live.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(jump).toHaveCount(0);

  await pushAgentLog(page, `\n${numberedLines(161, 240)}`);
  await expect(live).toContainText('line 240');
  await expect.poll(() => isAtBottom(live)).toBe(true);
  await expect(jump).toHaveCount(0);

  // Scrolling up pauses again; the button returns to the newest line.
  await live.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(jump).toBeVisible();
  await pushAgentLog(page, `\n${numberedLines(241, 320)}`);
  await expect(live).toContainText('line 320');
  await expect.poll(() => isAtBottom(live)).toBe(false);

  await jump.click();
  await expect.poll(() => isAtBottom(live)).toBe(true);
  await expect(jump).toHaveCount(0);
});

test('starts following when the drawer opens and leaves stored logs at the top', async ({
  page,
}) => {
  const state = await mockBoard(page);
  state.runs = [
    { ...state.runs[0], logs: numberedLines(1, 80) },
    RUNNING,
    { ...RUNNING, id: 'r-auth', issueId: 'i3', attemptNumber: 1 },
  ];
  await mockLiveAgentLog(page);

  await page.goto('/projects/p1/issues');
  await card(page, 'Schema').click();

  const panel = page.getByRole('dialog', { name: 'Schema' });
  const live = panel.getByTestId('live-agent-log');
  await pushAgentLog(page, numberedLines(1, 80));
  await expect(live).toContainText('line 80');
  await expect.poll(() => isAtBottom(live)).toBe(true);

  // The stored Logs disclosure stays a plain scroll box that opens at the top.
  await panel.getByText('Logs').click();
  const stored = panel.locator('details pre');
  await expect(stored).toBeVisible();
  expect(await stored.evaluate((element) => element.scrollTop)).toBe(0);

  // Pause, close, reopen: the drawer starts following again from the newest line.
  await live.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(panel.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close details' }).click();
  await card(page, 'Schema').click();

  const reopened = page.getByRole('dialog', { name: 'Schema' });
  const reopenedLive = reopened.getByTestId('live-agent-log');
  await expect(reopened.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);

  await pushAgentLog(page, `\n${numberedLines(81, 160)}`);
  await expect(reopenedLive).toContainText('line 160');
  await expect.poll(() => isAtBottom(reopenedLive)).toBe(true);

  // Opening the stored log after the new output still shows its first line.
  await reopened.getByText('Logs').click();
  const reopenedStored = reopened.locator('details pre');
  await expect(reopenedStored).toBeVisible();
  expect(await reopenedStored.evaluate((element) => element.scrollTop)).toBe(0);
});
