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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

async function mockSignedOut(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: true, authenticated: false } }),
  );
}

async function mockUnconfigured(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { setupComplete: false, authenticated: false } }),
  );
}

test('sends an unconfigured instance to the setup wizard', async ({ page }) => {
  await mockUnconfigured(page);

  await page.goto('/');

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up YAAABK' })).toBeVisible();
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
});

test('sends a signed-out Developer to the login page', async ({ page }) => {
  await mockSignedOut(page);

  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to YAAABK' })).toBeVisible();
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
});

test('shows a scannable QR code while setting up', async ({ page }) => {
  await mockUnconfigured(page);
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

  await expect(page.getByLabel('TOTP QR code').locator('svg')).toBeVisible();
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByLabel('Verification code')).toBeVisible();
});

test('asks for the second factor before signing in', async ({ page }) => {
  await mockSignedOut(page);
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
  await mockSignedOut(page);
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

  await expect(page.getByTestId('auth-card').getByRole('alert')).toHaveText(
    'Incorrect username or password',
  );
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`auth layout at ${viewport.name} size`, () => {
    test.use({ viewport });

    test('renders login as a branded card with touch-sized controls', async ({ page }) => {
      await mockSignedOut(page);
      await gotoHydrated(page, '/login');

      const card = page.getByTestId('auth-card');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('brand-lockup')).toBeVisible();
      await expectNoHorizontalOverflow(page);

      for (const label of ['Username', 'Password']) {
        const box = await page.getByLabel(label).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      const action = page.getByRole('button', { name: 'Continue' });
      const actionBox = await action.boundingBox();
      const cardBox = await card.boundingBox();
      expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(actionBox?.width ?? 0).toBeGreaterThanOrEqual((cardBox?.width ?? 0) - 64);
    });

    test('renders setup as a branded card with touch-sized controls', async ({ page }) => {
      await mockUnconfigured(page);
      await gotoHydrated(page, '/setup');

      const card = page.getByTestId('auth-card');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('brand-lockup')).toBeVisible();
      await expectNoHorizontalOverflow(page);

      for (const label of ['Username', 'Password']) {
        const box = await page.getByLabel(label).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      const action = page.getByRole('button', { name: 'Create account' });
      const actionBox = await action.boundingBox();
      const cardBox = await card.boundingBox();
      expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(actionBox?.width ?? 0).toBeGreaterThanOrEqual((cardBox?.width ?? 0) - 64);
    });
  });
}

test('keyboard order reaches every login field and action with a visible focus indicator', async ({
  page,
}) => {
  await mockSignedOut(page);
  await gotoHydrated(page, '/login');

  const username = page.getByLabel('Username');
  const password = page.getByLabel('Password');
  const action = page.getByRole('button', { name: 'Continue' });

  await page.keyboard.press('Tab');
  await expect(username).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();

  const indicator = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(indicator.outline !== 'none' || indicator.shadow !== 'none').toBe(true);
});
