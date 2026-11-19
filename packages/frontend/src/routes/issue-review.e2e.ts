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
  summary: 'A plan for saving bookmarks.',
  skillLevel: 'expert',
  source: 'grill-me',
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  acceptedAt: null,
};

const ACCEPTED_AT = '2026-01-02T00:00:00.000Z';

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
    label: 'refinement-needed',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 50,
    openrouterKeyHash: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const SCHEMA = issue({
  id: 'i1',
  title: 'Schema',
  label: 'ready',
  body: 'Create the tables',
  summary: 'Create the bookmark tables.',
});
const API = issue({
  id: 'i2',
  title: 'Api',
  label: 'refinement-needed',
  dependsOn: ['Schema'],
  summary: 'Expose the bookmark endpoints.',
  createdAt: '2026-01-02T00:00:00.000Z',
});

const GRAPH: IssueGraph = {
  nodes: [
    { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: 0 },
    { id: 'i2', title: 'Api', dependsOn: ['i1'], missing: [], wave: 1 },
  ],
  cycles: [],
};

interface Mocks {
  plans: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  graph: IssueGraph;
}

/** Mocks the project, its Plan versions and the issue endpoints. */
async function mockReview(page: Page, overrides: Partial<Mocks> = {}): Promise<Mocks> {
  const state: Mocks = {
    plans: [PLAN],
    issues: [SCHEMA, API],
    graph: GRAPH,
    ...overrides,
  };

  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );
  await page.route('**/api/projects/p1', (route) => route.fulfill({ json: PROJECT }));
  await page.route('**/api/projects/p1/plans', (route) =>
    route.fulfill({ json: { plans: state.plans } }),
  );
  await page.route('**/api/projects/p1/issues', (route) =>
    route.fulfill({ json: { issues: state.issues } }),
  );
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: state.graph }),
  );
  return state;
}

test('lists the plan versions and shows the active plan with its issues by wave', async ({
  page,
}) => {
  await mockReview(page);

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('heading', { name: 'Plan versions' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /v1.*Active.*Not accepted.*0\/2 closed/ }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan v1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wave 0' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wave 1' })).toBeVisible();
  await expect(page.getByText('A plan for saving bookmarks.')).toBeVisible();
  await expect(page.getByText('Create the bookmark tables.')).toBeVisible();
  await expect(page.getByText('Expose the bookmark endpoints.')).toBeVisible();
  await expect(page.getByText('refinement-needed')).toBeVisible();
  await expect(page.getByText('Depends on: Schema')).toBeVisible();
});

test('renders the Plan and Issue Markdown with typography', async ({ page }) => {
  const state = await mockReview(page);
  const contentMarkdown = '## Outcomes\n\n- Ship the board';
  state.plans = [{ ...PLAN, contentMarkdown }];
  state.issues = [
    issue({
      id: 'i1',
      title: 'Schema',
      label: 'ready',
      body: '## Context\n\n- Create the tables\n- Add indexes',
      summary: 'Create the bookmark tables.',
    }),
  ];
  state.graph = {
    nodes: [{ id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: 0 }],
    cycles: [],
  };

  await page.goto('/projects/p1/issues/review');

  const plan = page.locator('section[aria-labelledby="plan-heading"]');
  await expect(plan.getByText('A plan for saving bookmarks.')).toBeVisible();
  await expect(plan.getByRole('heading', { level: 2, name: 'Outcomes' })).toBeHidden();
  await plan.getByText('Show full plan').click();
  await expect(plan.getByRole('heading', { level: 2, name: 'Outcomes' })).toBeVisible();
  await expect(plan.getByRole('listitem')).toHaveCount(1);

  const issueItem = page.locator('section[aria-labelledby="issues-heading"] li');
  await expect(issueItem.getByText('Create the bookmark tables.')).toBeVisible();
  await expect(issueItem.getByRole('heading', { level: 2, name: 'Context' })).toBeHidden();
  await issueItem.getByText('Show full issue').click();
  await expect(issueItem.getByRole('heading', { level: 2, name: 'Context' })).toBeVisible();
  await expect(issueItem.getByRole('listitem')).toHaveCount(2);
  const listStyle = await issueItem.locator('ul').evaluate((element) => {
    return getComputedStyle(element).listStyleType;
  });
  expect(listStyle).toBe('disc');
});

test('shows every issue of the selected plan, including closed ones', async ({ page }) => {
  const state = await mockReview(page);
  state.issues = [
    ...state.issues,
    issue({ id: 'i3', title: 'Finished', status: 'closed', planId: 'v1' }),
    issue({ id: 'i4', title: 'Legacy', planId: 'v0', createdAt: '2026-01-03T00:00:00.000Z' }),
  ];
  state.graph = {
    nodes: [
      ...state.graph.nodes,
      { id: 'i3', title: 'Finished', dependsOn: [], missing: [], wave: 0 },
      { id: 'i4', title: 'Legacy', dependsOn: [], missing: [], wave: 0 },
    ],
    cycles: [],
  };

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByText('Schema', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Finished', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('closed', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Issues (3)' })).toBeVisible();
});

test('shows a completed plan once it was accepted and every issue is closed', async ({ page }) => {
  const state = await mockReview(page);
  state.plans = [{ ...PLAN, acceptedAt: ACCEPTED_AT }];
  state.issues = state.issues.map((item) => ({ ...item, status: 'closed' }));

  await page.goto('/projects/p1/issues/review');

  await expect(
    page.getByRole('button', { name: /v1.*Active.*Completed.*2\/2 closed/ }),
  ).toBeVisible();
  const plan = page.locator('section[aria-labelledby="plan-heading"]');
  await expect(plan.getByText('Completed')).toBeVisible();
  await expect(plan.getByText('Accept plan')).toHaveCount(0);
});

test('warns about circular dependencies', async ({ page }) => {
  const state = await mockReview(page);
  state.graph = {
    nodes: [
      { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: null },
      { id: 'i2', title: 'Api', dependsOn: [], missing: [], wave: null },
    ],
    cycles: [['i1', 'i2']],
  };

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('heading', { name: 'Circular dependencies' })).toBeVisible();
  await expect(page.getByText('i1 → i2 → i1')).toBeVisible();
});

test('offers no one-shot generation or prompt refinement', async ({ page }) => {
  await mockReview(page);

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('button', { name: 'Generate from plan' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Refine with prompt' })).toHaveCount(0);
  await expect(page.getByLabel('Refinement feedback')).toHaveCount(0);
});

test('accepts the plan through a modal that explains the GitHub sync', async ({ page }) => {
  const state = await mockReview(page);
  await page.route('**/api/projects/p1/plans/v1/accept', (route) => {
    state.plans = state.plans.map((plan) => ({ ...plan, acceptedAt: ACCEPTED_AT }));
    state.issues = state.issues.map((item, index) => ({ ...item, githubNumber: index + 1 }));
    return route.fulfill({ json: state.plans[0] });
  });

  await page.goto('/projects/p1/issues/review');
  await page.getByRole('button', { name: 'Accept plan', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Accept Plan v1?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/creates or updates its Issues on GitHub/)).toBeVisible();
  await expect(dialog.getByText(/agents start on the Issues labelled/)).toBeVisible();
  await expect(dialog.getByText(/needs-human/)).toBeVisible();
  await expect(dialog.getByText(/Issue labels do not change/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Accept Plan v1' }).click();

  await expect(page.getByText('Plan v1 accepted and synced to GitHub.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /v1.*Active.*In progress.*0\/2 closed/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry GitHub sync' })).toHaveCount(0);
});

test('offers Retry accept with the failure reason and keeps the plan unaccepted', async ({
  page,
}) => {
  const state = await mockReview(page);
  let attempts = 0;
  await page.route('**/api/projects/p1/plans/v1/accept', (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        status: 502,
        json: { error: 'sync-failed', message: 'Bad credentials' },
      });
    }
    state.plans = state.plans.map((plan) => ({ ...plan, acceptedAt: ACCEPTED_AT }));
    state.issues = state.issues.map((item, index) => ({ ...item, githubNumber: index + 1 }));
    return route.fulfill({ json: state.plans[0] });
  });

  await page.goto('/projects/p1/issues/review');
  await page.getByRole('button', { name: 'Accept plan', exact: true }).click();
  await page.getByRole('button', { name: 'Accept Plan v1' }).click();

  await expect(page.getByRole('alert').getByText('Bad credentials')).toBeVisible();
  await expect(
    page
      .getByRole('alert')
      .getByText('The Plan was not accepted. Its Issues are safe to sync again.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /v1.*Active.*Not accepted/ })).toBeVisible();

  await page.getByRole('button', { name: 'Retry accept' }).click();

  await expect(page.getByText('Plan v1 accepted and synced to GitHub.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry accept' })).toHaveCount(0);
});

test('shows a small Retry GitHub sync only for an accepted plan with unsynced issues', async ({
  page,
}) => {
  const state = await mockReview(page);
  state.plans = [{ ...PLAN, acceptedAt: ACCEPTED_AT }];

  await page.goto('/projects/p1/issues/review');
  await page.route('**/api/projects/p1/issues/sync/push', (route) => {
    state.issues = state.issues.map((item, index) => ({ ...item, githubNumber: index + 1 }));
    return route.fulfill({
      json: {
        created: 2,
        updated: 0,
        status: { total: 2, synced: 2, pending: 0, lastSyncedAt: '2026-01-02T00:00:00.000Z' },
      },
    });
  });

  await expect(page.getByRole('button', { name: 'Retry GitHub sync' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry GitHub sync' }).click();

  await expect(page.getByText('GitHub in sync · 2 created')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry GitHub sync' })).toHaveCount(0);
});

test('defaults to the active plan and shows a previous plan read-only', async ({ page }) => {
  const previous = {
    ...PLAN,
    id: 'v0',
    version: 1,
    isActive: false,
    acceptedAt: ACCEPTED_AT,
    contentMarkdown: '# Previous plan',
    summary: 'The previous plan.',
  };
  const active = {
    ...PLAN,
    id: 'v2',
    version: 2,
    isActive: true,
    contentMarkdown: '# Active plan',
    summary: 'The active plan.',
  };
  const state = await mockReview(page, {
    plans: [active, previous],
    issues: [
      issue({ id: 'old', title: 'Old work', planId: 'v0', status: 'closed' }),
      issue({ id: 'new', title: 'New work', planId: 'v2', label: 'ready' }),
    ],
    graph: {
      nodes: [
        { id: 'old', title: 'Old work', dependsOn: [], missing: [], wave: 0 },
        { id: 'new', title: 'New work', dependsOn: [], missing: [], wave: 0 },
      ],
      cycles: [],
    },
  });

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('heading', { name: 'Plan v2' })).toBeVisible();
  await expect(page.getByText('The active plan.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept plan', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /v1.*Previous.*Completed/ }).click();

  await expect(page.getByRole('heading', { name: 'Plan v1' })).toBeVisible();
  await expect(page.getByText('The previous plan.')).toBeVisible();
  await expect(page.getByText(/This is a previous Plan/)).toBeVisible();
  await expect(page.getByText('Old work', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('New work', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept plan', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /v2.*Active/ }).click();
  await expect(page.getByRole('button', { name: 'Accept plan', exact: true })).toBeVisible();
  expect(state.plans).toHaveLength(2);
});

test('offers a route back to a new grill session when there are no issues', async ({ page }) => {
  await mockReview(page, { issues: [], graph: { nodes: [], cycles: [] } });

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByText('No issues yet.')).toBeVisible();
  await expect(
    page.getByText('Finish an agent session to publish a Plan and its Issues.'),
  ).toBeVisible();
  await expect(
    page
      .locator('section[aria-labelledby="issues-heading"]')
      .getByRole('link', { name: 'Start a new agent session' }),
  ).toHaveAttribute('href', '/projects/p1/plan');
});
