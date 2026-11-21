import { expect, test, type Page } from '@playwright/test';
import type { IssueGraph } from '@yaaabk/issues';

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

const PLAN = {
  id: 'v1',
  projectId: 'p1',
  version: 1,
  contentMarkdown: '# Plan',
  summary: 'A plan for saving bookmarks.',
  mode: 'guided',
  source: 'grill-me',
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  acceptedAt: null,
};

const ACCEPTED_AT = '2026-01-02T00:00:00.000Z';

const OVERVIEW = {
  project: PROJECT,
  activePlan: null,
  activeWork: [],
  issues: { total: 0, open: 0, inProgress: 0, closed: 0, failed: 0, averageAttempts: 0 },
  lastRunAt: null,
};

const MODELS = {
  models: [{ id: 'openrouter/default-model', name: 'Default model' }],
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
  await page.route('**/api/projects/p1/overview', (route) => route.fulfill({ json: OVERVIEW }));
  await page.route('**/api/projects/p1/plans', (route) =>
    route.fulfill({ json: { plans: state.plans } }),
  );
  await page.route('**/api/projects/p1/issues', (route) =>
    route.fulfill({ json: { issues: state.issues } }),
  );
  await page.route('**/api/projects/p1/issues/graph', (route) =>
    route.fulfill({ json: state.graph }),
  );
  // Endpoints the issue board reads after a successful accept lands there.
  await page.route('**/api/projects/p1/plans/active', (route) =>
    route.fulfill({ json: state.plans.find((plan) => plan.isActive) ?? null }),
  );
  await page.route('**/api/projects/p1/agent-runs', (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route('**/api/models', (route) => route.fulfill({ json: MODELS }));
  return state;
}

/** Picks a Plan version through the control the current viewport renders. */
async function selectVersion(page: Page, planId: string, desktopName: RegExp): Promise<void> {
  if (test.info().project.name === 'mobile') {
    await page.getByLabel('Plan version', { exact: true }).selectOption(planId);
    return;
  }
  await page
    .getByRole('navigation', { name: 'Plan versions' })
    .getByRole('button', { name: desktopName })
    .click();
}

test('shows Plan versions beside the selected Plan and marks the selection', async ({ page }) => {
  await mockReview(page);

  await page.goto('/projects/p1/issues/review');

  const mobile = test.info().project.name === 'mobile';
  if (mobile) {
    await expect(page.getByLabel('Plan version', { exact: true })).toHaveValue('v1');
  } else {
    const versions = page.getByRole('navigation', { name: 'Plan versions' });
    await expect(versions).toBeVisible();
    const selected = versions.getByRole('button', {
      name: /v1.*Active.*Not accepted.*0\/2 closed/,
    });
    await expect(selected).toBeVisible();
    await expect(selected).toHaveAttribute('aria-current', 'true');
  }
  await expect(page.getByRole('heading', { name: 'Plan v1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wave 0' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wave 1' })).toBeVisible();
  await expect(page.getByText('A plan for saving bookmarks.')).toBeVisible();
  await expect(page.getByText('Create the bookmark tables.')).toBeVisible();
  await expect(page.getByText('Expose the bookmark endpoints.')).toBeVisible();
  await expect(page.getByText('refinement-needed')).toBeVisible();
  await expect(page.getByText('Depends on: Schema')).toBeVisible();
});

test('switches Plans from the desktop list and the phone select', async ({ page }) => {
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
  await mockReview(page, {
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

  const mobile = test.info().project.name === 'mobile';
  const select = page.getByLabel('Plan version', { exact: true });
  if (mobile) {
    await expect(page.getByRole('navigation', { name: 'Plan versions' })).toBeHidden();
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('v2');
    await select.selectOption('v0');
  } else {
    await expect(select).toBeHidden();
    const versions = page.getByRole('navigation', { name: 'Plan versions' });
    const previousButton = versions.getByRole('button', { name: /v1.*Previous.*Completed/ });
    await previousButton.click();
    await expect(previousButton).toHaveAttribute('aria-current', 'true');
  }

  await expect(page.getByRole('heading', { name: 'Plan v1', exact: true })).toBeVisible();
  await expect(page.getByText('The previous plan.')).toBeVisible();
  await expect(page.getByText(/This previous Plan is read-only/)).toBeVisible();

  if (mobile) {
    await select.selectOption('v2');
    await expect(page.getByText('The active plan.')).toBeVisible();

    const acceptBar = page.getByTestId('accept-bar');
    await expect(acceptBar).toBeVisible();
    const accept = acceptBar.getByRole('button', { name: 'Accept plan' });
    await accept.scrollIntoViewIfNeeded();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
    const withinViewport = await accept.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    });
    expect(withinViewport).toBe(true);
  }
});

test('renders the Plan and Issue Markdown with typography', async ({ page }) => {
  const state = await mockReview(page);
  const contentMarkdown =
    '## Outcomes\n\n- Ship the board\n\n<img src="x" onerror="window.__pwned = true">';
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

  const plan = page.getByTestId('plan-detail');
  await expect(plan.getByText('A plan for saving bookmarks.')).toBeVisible();
  await expect(plan.getByRole('heading', { level: 2, name: 'Outcomes' })).toBeHidden();
  await plan.getByText('Show full plan').click();
  await expect(plan.getByRole('heading', { level: 2, name: 'Outcomes' })).toBeVisible();
  await expect(plan.getByRole('listitem')).toHaveCount(1);

  const issueItem = page.getByTestId('issue-list').locator('li').first();
  await expect(issueItem.getByText('Create the bookmark tables.')).toBeVisible();
  await expect(issueItem.getByRole('heading', { level: 2, name: 'Context' })).toBeHidden();
  await issueItem.getByText('Show full issue').click();
  await expect(issueItem.getByRole('heading', { level: 2, name: 'Context' })).toBeVisible();
  await expect(issueItem.getByRole('listitem')).toHaveCount(2);
  const listStyle = await issueItem.locator('ul').evaluate((element) => {
    return getComputedStyle(element).listStyleType;
  });
  expect(listStyle).toBe('disc');

  await expect.poll(() => page.evaluate(() => '__pwned' in window)).toBe(false);
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

  if (test.info().project.name === 'mobile') {
    await expect(page.getByLabel('Plan version', { exact: true })).toHaveValue('v1');
  } else {
    await expect(
      page.getByRole('button', { name: /v1.*Active.*Completed.*2\/2 closed/ }),
    ).toBeVisible();
  }
  const plan = page.getByTestId('plan-detail');
  await expect(plan.getByText('Completed')).toBeVisible();
  await expect(page.getByTestId('accept-bar')).toHaveCount(0);
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

  await expect(page.getByTestId('cycles')).toContainText('Circular dependencies');
  await expect(page.getByText('i1 → i2 → i1')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unordered (cycle)' })).toBeVisible();
  // Cycles are called out before the accept action, which stays available
  // because an unorderable Plan can still be accepted today.
  await expect(page.getByTestId('accept-bar')).toBeVisible();
  const cyclesBeforeAccept = await page.evaluate(() => {
    const cycles = document.querySelector('[data-testid="cycles"]');
    const accept = document.querySelector('[data-testid="accept-bar"]');
    return (
      cycles !== null &&
      accept !== null &&
      Boolean(cycles.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(cyclesBeforeAccept).toBe(true);
});

test('warns when an Issue depends on something that is not in the Plan', async ({ page }) => {
  const state = await mockReview(page);
  state.graph = {
    nodes: [
      { id: 'i1', title: 'Schema', dependsOn: [], missing: [], wave: 0 },
      { id: 'i2', title: 'Api', dependsOn: ['Schema', 'Ghost'], missing: ['Ghost'], wave: 1 },
    ],
    cycles: [],
  };

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByText('Missing dependency: Ghost')).toBeVisible();
});

test('offers no one-shot generation or prompt refinement', async ({ page }) => {
  await mockReview(page);

  await page.goto('/projects/p1/issues/review');

  await expect(page.getByRole('button', { name: 'Generate from plan' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Refine with prompt' })).toHaveCount(0);
  await expect(page.getByLabel('Refinement feedback')).toHaveCount(0);
});

test('lands on the issue board after accepting the plan', async ({ page }) => {
  const state = await mockReview(page);
  await page.route('**/api/projects/p1/plans/v1/accept', (route) => {
    state.plans = state.plans.map((plan) => ({ ...plan, acceptedAt: ACCEPTED_AT }));
    state.issues = state.issues.map((item, index) => ({ ...item, githubNumber: index + 1 }));
    return route.fulfill({ json: state.plans[0] });
  });

  await page.goto('/projects/p1/issues/review');
  await page.getByTestId('open-accept-dialog').click();

  const dialog = page.getByRole('dialog', { name: 'Accept Plan v1?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/creates or updates its Issues on GitHub/)).toBeVisible();
  await expect(dialog.locator('[data-slot="dialog-description"]')).toContainText(
    'agents start on the Issues labelled',
  );
  await expect(dialog.getByText(/needs-human/)).toBeVisible();
  await expect(dialog.getByText(/Issue labels do not change/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Accept Plan v1' }).click();

  await expect(page.getByRole('heading', { name: 'Issue board' })).toBeVisible();
  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review plan' })).toHaveCount(0);
});

test('names the version in the accept bar and confirms in an accessible dialog', async ({
  page,
}) => {
  await mockReview(page);

  await page.goto('/projects/p1/issues/review');

  const bar = page.getByTestId('accept-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Accept Plan v1');

  const trigger = bar.getByTestId('open-accept-dialog');
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Accept Plan v1?');
  await expect(dialog).toContainText('creates or updates its Issues on GitHub');
  await expect(dialog).toContainText('agents start on the Issues labelled');
  await expect(dialog).toContainText('needs-human');
  await expect(dialog).toContainText('Issue labels do not change');

  // Focus starts inside the dialog and Tab cannot leave it.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
    .toBe(true);
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
      .toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Cancel closes without accepting and also restores the trigger.
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(bar).toBeVisible();
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
  await page.getByTestId('open-accept-dialog').click();
  await page.getByRole('button', { name: 'Accept Plan v1' }).click();

  await expect(page.getByRole('alert').getByText('Bad credentials')).toBeVisible();
  await expect(
    page
      .getByRole('alert')
      .getByText('The Plan was not accepted. Its Issues are safe to sync again.'),
  ).toBeVisible();
  await expect(page.getByTestId('accept-bar')).toContainText('Plan v1');

  await page.getByRole('button', { name: 'Retry accept' }).click();

  await expect(page.getByRole('heading', { name: 'Issue board' })).toBeVisible();
  await expect(page.getByText('Plan v1 accepted and synced to GitHub')).toBeVisible();
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

  await expect(page.getByRole('heading', { name: 'Plan v2', exact: true })).toBeVisible();
  await expect(page.getByText('The active plan.')).toBeVisible();
  await expect(page.getByTestId('open-accept-dialog')).toBeVisible();

  await selectVersion(page, 'v0', /v1.*Previous.*Completed/);

  await expect(page.getByRole('heading', { name: 'Plan v1', exact: true })).toBeVisible();
  await expect(page.getByText('The previous plan.')).toBeVisible();
  await expect(page.getByText(/This previous Plan is read-only/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Reactivate it on the Plan page/ })).toHaveAttribute(
    'href',
    '/projects/p1/plan',
  );
  await expect(page.getByText('Old work', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('New work', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('open-accept-dialog')).toHaveCount(0);

  await selectVersion(page, 'v2', /v2.*Active/);
  await expect(page.getByTestId('open-accept-dialog')).toBeVisible();
  expect(state.plans).toHaveLength(2);
});

test('opens the Plan named in the query string', async ({ page }) => {
  const previous = {
    ...PLAN,
    id: 'v0',
    version: 1,
    isActive: false,
    acceptedAt: ACCEPTED_AT,
    summary: 'The previous plan.',
  };
  const active = { ...PLAN, id: 'v2', version: 2, isActive: true, summary: 'The active plan.' };
  await mockReview(page, {
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

  await page.goto('/projects/p1/issues/review?plan=v0');

  await expect(page.getByRole('heading', { name: 'Plan v1', exact: true })).toBeVisible();
  await expect(page.getByText('The previous plan.')).toBeVisible();
  if (test.info().project.name === 'mobile') {
    await expect(page.getByLabel('Plan version', { exact: true })).toHaveValue('v0');
  } else {
    await expect(
      page
        .getByRole('navigation', { name: 'Plan versions' })
        .getByRole('button', { name: /v1.*Previous.*Completed/ }),
    ).toHaveAttribute('aria-current', 'true');
  }
});

test('explains a Plan published without Issues and offers no Accept', async ({ page }) => {
  await mockReview(page, { issues: [], graph: { nodes: [], cycles: [] } });

  await page.goto('/projects/p1/issues/review');

  await expect(
    page.getByText(
      'This Plan was published without Issues, so it cannot be accepted. A new agent session is needed to publish a revised Plan.',
    ),
  ).toBeVisible();
  await expect(page.getByTestId('open-accept-dialog')).toHaveCount(0);
  await expect(page.getByTestId('accept-bar')).toHaveCount(0);
  await expect(
    page.getByTestId('issue-list').getByRole('link', { name: 'Start a new agent session' }),
  ).toHaveAttribute('href', '/projects/p1/plan');
});
