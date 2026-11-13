import { expect, test } from '@playwright/test';

test('landing page loads and identifies the product', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } },
    }),
  );

  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('YAAABK');
  await expect(page.getByText('Yet Another AI App Builder for Kubernetes')).toBeVisible();
});
