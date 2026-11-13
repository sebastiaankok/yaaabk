import { expect, test, type Page } from '@playwright/test';

/**
 * Navigates and waits until the client app has hydrated.
 *
 * The root layout fetches `/api/auth/status` once it is running, so waiting for
 * that response proves the form handlers are attached — without it, a click can
 * land before hydration and submit the form natively.
 */
async function gotoHydrated(page: Page, path: string): Promise<void> {
  const hydrated = page.waitForResponse((response) => response.url().includes('/api/auth/status'));
  await page.goto(path);
  await hydrated;
}

test('sends an unconfigured instance to the setup wizard', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: false, authenticated: false } }),
  );

  await page.goto('/');

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up YAAABK' })).toBeVisible();
});

test('sends a signed-out Developer to the login page', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: true, authenticated: false } }),
  );

  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to YAAABK' })).toBeVisible();
});

test('shows a scannable QR code while setting up', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: false, authenticated: false } }),
  );
  await page.route('**/api/auth/setup', (route) =>
    route.fulfill({
      json: {
        setupToken: 'setup-token',
        otpauthUri: 'otpauth://totp/YAAABK:alice?secret=JBSWY3DPEHPK3PXP&issuer=YAAABK',
        secret: 'JBSWY3DPEHPK3PXP',
      },
    }),
  );

  await gotoHydrated(page, '/setup');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('vX7$qmPz2!Lw9Rt');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.locator('svg')).toBeVisible();
  await expect(page.getByLabel('Verification code')).toBeVisible();
});

test('asks for the second factor before signing in', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: true, authenticated: false } }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ json: { pendingToken: 'pending-token' } }),
  );

  await gotoHydrated(page, '/login');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('vX7$qmPz2!Lw9Rt');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByLabel('Verification code')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('shows a generic error for bad credentials', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: true, authenticated: false } }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 401,
      json: { error: 'invalid-credentials', message: 'Incorrect username or password' },
    }),
  );

  await gotoHydrated(page, '/login');
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password');
});
