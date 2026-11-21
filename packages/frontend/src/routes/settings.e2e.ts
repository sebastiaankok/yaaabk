import { expect, test, type Page } from '@playwright/test';

/**
 * Navigates and waits until the page's settings have loaded — that request only
 * fires once the client app has hydrated, so the wait also proves the click
 * handlers are attached (see auth.e2e.ts for the pattern).
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  const loaded = page.waitForResponse((response) => response.url().includes('/api/settings'));
  await page.goto(path);
  await loaded;
}

const CONFIGURED_SETTINGS = {
  githubAppId: 'app 12345',
  githubPrivateKey: '…-key',
  githubInstallationId: '67890',
  openrouterManagementKey: 'sk-or-…1c96',
  defaultIssueBudgetCents: 50,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const HEALTHY_CREDITS = {
  totalCreditsUsd: 10,
  totalUsageUsd: 1,
  remainingUsd: 9,
  defaultModel: 'anthropic/claude-sonnet-4.5',
  reservationUsd: 0.5,
};

/** Authenticates the mocked session so the layout renders the page. */
function mockSession(page: Page): void {
  void page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'user-1', username: 'alice' } },
    }),
  );
}

function mockCredits(page: Page, view = HEALTHY_CREDITS): void {
  void page.route('**/api/settings/openrouter/credits', (route) => route.fulfill({ json: view }));
}

const CREDENTIALS = [
  'githubAppId',
  'githubPrivateKey',
  'githubInstallationId',
  'githubPat',
  'openrouterManagementKey',
] as const;

/**
 * The masked view the API would return for an update: secrets are masked and
 * cleared fields disappear, exactly as the backend behaves.
 */
function viewAfterUpdate(
  stored: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored, updatedAt: new Date().toISOString() };
  const cleared = Array.isArray(update.clear) ? update.clear : [];
  for (const field of CREDENTIALS) {
    if (cleared.includes(field)) delete next[field];
    if (typeof update[field] === 'string') next[field] = `${field}-masked`;
  }
  if (typeof update.defaultIssueBudgetCents === 'number') {
    next.defaultIssueBudgetCents = update.defaultIssueBudgetCents;
  }
  return next;
}

/** Records PUT bodies and serves the masked settings view a real backend would. */
async function mockSettings(
  page: Page,
  initial: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const puts: Record<string, unknown>[] = [];
  let stored = initial;
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({ json: stored });
      return;
    }
    const update = route.request().postDataJSON() as Record<string, unknown>;
    puts.push(update);
    stored = viewAfterUpdate(stored, update);
    void route.fulfill({ json: stored });
  });
  return puts;
}

test('shows three cards and masks stored secrets without echoing them into inputs', async ({
  page,
}) => {
  await mockSession(page);
  await mockSettings(page, CONFIGURED_SETTINGS);
  mockCredits(page);

  await gotoHydrated(page, '/settings');

  await expect(page.getByTestId('github-card')).toBeVisible();
  await expect(page.getByTestId('openrouter-card')).toBeVisible();
  await expect(page.getByTestId('spending-card')).toBeVisible();

  await expect(page.getByTestId('github-app-id-hint')).toHaveText('Configured: app 12345');
  await expect(page.getByTestId('github-private-key-hint')).toHaveText('Configured: …-key');
  await expect(page.getByTestId('github-installation-id-hint')).toHaveText('Configured: 67890');
  await expect(page.getByTestId('openrouter-key-hint')).toHaveText('Configured: sk-or-…1c96');

  // Secrets are hints, not values: every editable field starts blank and the
  // secret inputs are password fields.
  const values = await page
    .locator(
      '#github-app-id, #github-private-key, #github-installation-id, #openrouter-management-key',
    )
    .evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value));
  expect(values).toEqual(['', '', '', '']);
  await expect(page.locator('#openrouter-management-key')).toHaveAttribute('type', 'password');
});

test('renders App and token modes and saves the fields of each', async ({ page }) => {
  const puts = await mockSettings(page, { updatedAt: '2026-01-01T00:00:00.000Z' });

  await mockSession(page);
  await gotoHydrated(page, '/settings');

  // App mode is the default and shows its three fields, not the PAT field.
  await expect(page.locator('#github-app-id')).toBeVisible();
  await expect(page.locator('#github-private-key')).toBeVisible();
  await expect(page.locator('#github-installation-id')).toBeVisible();
  await expect(page.locator('#github-pat')).toHaveCount(0);

  await page.locator('#github-app-id').fill('123456');
  await page.locator('#github-private-key').fill('test-pem-contents');
  await page.locator('#github-installation-id').fill('7890');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('save-status')).toContainText('All changes saved');

  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({
    githubAppId: '123456',
    githubPrivateKey: 'test-pem-contents',
    githubInstallationId: '7890',
  });

  // Token mode swaps the fields and saves the PAT, clearing the App credentials.
  await page.getByRole('radio', { name: 'Personal access token' }).check();
  await expect(page.locator('#github-pat')).toBeVisible();
  await expect(page.locator('#github-app-id')).toHaveCount(0);

  await page.locator('#github-pat').fill('ghp_newtoken');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('save-status')).toContainText('All changes saved');

  expect(puts).toHaveLength(2);
  expect(puts[1]).toMatchObject({ githubPat: 'ghp_newtoken' });
  expect(puts[1].clear).toEqual(
    expect.arrayContaining(['githubAppId', 'githubPrivateKey', 'githubInstallationId']),
  );
});

test('keeps each verify action and its result in the card it belongs to', async ({ page }) => {
  await mockSession(page);
  await mockSettings(page, CONFIGURED_SETTINGS);
  mockCredits(page);
  await page.route('**/api/settings/github/verify', (route) =>
    route.fulfill({ json: { ok: true, kind: 'app', account: 'octo-app' } }),
  );
  await page.route('**/api/settings/openrouter/verify', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'unauthorized', message: 'OpenRouter rejected the management key' },
    }),
  );

  await gotoHydrated(page, '/settings');

  const github = page.getByTestId('github-card');
  const openrouter = page.getByTestId('openrouter-card');

  await github.getByRole('button', { name: 'Verify GitHub' }).click();
  await expect(github.getByTestId('github-verify-result')).toHaveText(
    'Verified: GitHub App octo-app',
  );
  await expect(openrouter.getByTestId('github-verify-result')).toHaveCount(0);

  await openrouter.getByRole('button', { name: 'Verify OpenRouter' }).click();
  await expect(openrouter.getByTestId('openrouter-verify-result')).toHaveText(
    'OpenRouter rejected the management key',
  );
  await expect(github.getByTestId('openrouter-verify-result')).toHaveCount(0);
});

test('reports unsaved, saving, saved and failed, with one dismissible toast per save', async ({
  page,
}) => {
  await mockSession(page);
  await mockSettings(page, { updatedAt: '2026-01-01T00:00:00.000Z' });

  let fail = false;
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    if (fail) {
      await route.fulfill({
        status: 500,
        json: { error: 'server', message: 'Settings are read-only right now' },
      });
      return;
    }
    // Hold the response so the in-flight state is observable.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fallback();
  });

  await gotoHydrated(page, '/settings');

  const status = page.getByTestId('save-status');
  const save = page.getByRole('button', { name: 'Save settings' });

  await expect(status).toHaveText('No unsaved changes');
  await expect(save).toBeDisabled();

  await page.locator('#openrouter-management-key').fill('sk-or-v1-new');
  await expect(status).toHaveText('Unsaved changes');
  await expect(save).toBeEnabled();

  await save.click();
  await expect(status).toHaveText('Saving…');
  await expect(status).toHaveText('All changes saved');

  const toast = page.locator('[data-sonner-toast]');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('Settings saved');
  await expect(page.locator('section[aria-live="polite"]')).toContainText('Settings saved');

  // A successful save raises exactly one toast, and it can be dismissed.
  await toast.locator('[data-close-button]').click();
  await expect(toast).toHaveCount(0);

  // A failed save stays visible and does not toast.
  fail = true;
  await page.locator('#openrouter-management-key').fill('sk-or-v1-fail');
  await save.click();
  await expect(status).toContainText('Save failed');
  await expect(status).toContainText('Settings are read-only right now');
  await expect(toast).toHaveCount(0);

  // Retrying after the failure succeeds and raises one fresh toast.
  fail = false;
  await save.click();
  await expect(status).toHaveText('All changes saved');
  await expect(toast).toHaveCount(1);
});

test('rejects an invalid budget inline before sending a request', async ({ page }) => {
  const puts = await mockSettings(page, { updatedAt: '2026-01-01T00:00:00.000Z' });

  await mockSession(page);
  await gotoHydrated(page, '/settings');

  const budget = page.locator('#default-issue-budget');
  await budget.fill('5.01');
  await page.getByRole('button', { name: 'Save settings' }).click();

  await expect(page.getByTestId('budget-error')).toHaveText(
    'The per-issue budget must be between $0.01 and $5.00',
  );
  await expect(budget).toHaveAttribute('aria-invalid', 'true');
  expect(puts).toHaveLength(0);

  // Correcting the field clears the error without a round trip.
  await budget.fill('0.50');
  await expect(page.getByTestId('budget-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ defaultIssueBudgetCents: 50 });
});

test('renders the balance and low-balance warning as a Spending status block', async ({ page }) => {
  await mockSession(page);
  await mockSettings(page, CONFIGURED_SETTINGS);
  mockCredits(page, { ...HEALTHY_CREDITS, totalUsageUsd: 9.8, remainingUsd: 0.2 });

  await gotoHydrated(page, '/settings');

  const spending = page.getByTestId('spending-card');
  const balance = spending.getByTestId('balance-status');

  await expect(balance).toContainText('OpenRouter account balance');
  await expect(balance).toContainText('Remaining $0.20 of $10.00 ($9.80 used)');
  await expect(spending.getByTestId('balance-warning')).toContainText(
    'The OpenRouter account has $0.20 in credits left, but anthropic/claude-sonnet-4.5 can reserve up to $0.50 for one reply.',
  );
  await expect(page.getByTestId('openrouter-card').getByTestId('balance-warning')).toHaveCount(0);
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('keeps the sticky bar above content, the keyboard and horizontal overflow', async ({
    page,
  }) => {
    await mockSession(page);
    await mockSettings(page, CONFIGURED_SETTINGS);
    mockCredits(page);

    await gotoHydrated(page, '/settings');

    const bar = page.getByTestId('save-bar');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844 + 1);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
    }

    // At full scroll the bar sits after the last card rather than over it.
    const spendingBox = await page.getByTestId('spending-card').boundingBox();
    expect(spendingBox).not.toBeNull();
    if (spendingBox !== null && box !== null) {
      expect(spendingBox.y + spendingBox.height).toBeLessThanOrEqual(box.y + 1);
    }
    await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
    expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe('sticky');

    // Simulate the on-screen keyboard shrinking the visual viewport.
    await page.setViewportSize({ width: 390, height: 420 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const keyboardBox = await bar.boundingBox();
    expect(keyboardBox).not.toBeNull();
    if (keyboardBox !== null) {
      expect(keyboardBox.y + keyboardBox.height).toBeLessThanOrEqual(420 + 1);
    }
    await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();

    // No horizontal overflow at 360px.
    await page.setViewportSize({ width: 360, height: 800 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test('saves credentials without a budget, leaving the stored budget alone', async ({ page }) => {
  const puts = await mockSettings(page, { updatedAt: '2026-01-01T00:00:00.000Z' });

  await mockSession(page);
  await gotoHydrated(page, '/settings');

  await page.getByLabel('App ID').fill('123456');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ githubAppId: '123456' });
  expect(puts[0]).not.toHaveProperty('defaultIssueBudgetCents');
});
