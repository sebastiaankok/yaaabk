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
  githubPat: 'ghp_o…1234',
  openrouterManagementKey: 'sk-or-…1c96',
  defaultIssueBudgetCents: 50,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Authenticates the mocked session so the layout renders the page. */
function mockSession(page: Page): void {
  void page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'user-1', username: 'alice' } },
    }),
  );
}

test('shows what is configured as masked hints, never plaintext', async ({ page }) => {
  await mockSession(page);
  await page.route('**/api/settings', (route) => void route.fulfill({ json: CONFIGURED_SETTINGS }));

  await gotoHydrated(page, '/settings');

  await expect(page.getByText('Configured: ghp_o…1234')).toBeVisible();
  await expect(page.getByText('Configured: sk-or-…1c96')).toBeVisible();
  const body = await page.textContent('body');
  expect(body).not.toContain('sk-or-v1-real');
});

test('confirms a save and reports the verification result', async ({ page }) => {
  await mockSession(page);
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({ json: CONFIGURED_SETTINGS });
      return;
    }
    void route.fulfill({ json: { ...CONFIGURED_SETTINGS, defaultIssueBudgetCents: 125 } });
  });
  await page.route('**/api/settings/openrouter/verify', (route) =>
    route.fulfill({ json: { ok: true, keys: 3 } }),
  );

  await gotoHydrated(page, '/settings');

  await page.getByLabel('Default per-issue budget (USD)').fill('1.25');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  await page.getByRole('button', { name: 'Verify' }).nth(1).click();
  await expect(page.getByText('Verified: 3 keys managed')).toBeVisible();
});

test('surfaces a bad management key as an inline error', async ({ page }) => {
  await mockSession(page);
  await page.route('**/api/settings', (route) => void route.fulfill({ json: CONFIGURED_SETTINGS }));
  await page.route('**/api/settings/openrouter/verify', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'unauthorized', message: 'OpenRouter rejected the management key' },
    }),
  );

  await gotoHydrated(page, '/settings');

  await page.getByRole('button', { name: 'Verify' }).nth(1).click();
  await expect(page.getByText('OpenRouter rejected the management key')).toBeVisible();
});
