import { expect, test, type Page } from '@playwright/test';
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
};

interface Mocks {
  issues: Record<string, unknown>[];
  graph: IssueGraph;
  runs: Record<string, unknown>[];
  budgets: Record<string, Record<string, unknown>>;
}

/** Mocks the project and the endpoints the board reads on load. */
async function mockBoard(page: Page): Promise<Mocks> {
  const state: Mocks = {
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
  await page.route('**/api/projects/p1/plans/active', (route) => route.fulfill({ json: PLAN }));
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
