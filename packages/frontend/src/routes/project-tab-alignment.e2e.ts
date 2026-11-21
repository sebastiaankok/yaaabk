import { expect, test } from '@playwright/test';

/** Every Project tab, in the order the tab bar shows them. */
const TABS = [
  { path: '/projects/p1', tab: 'Overview' },
  { path: '/projects/p1/plan', tab: 'Plan' },
  { path: '/projects/p1/issues/review', tab: 'Review' },
  { path: '/projects/p1/issues', tab: 'Issues' },
  { path: '/projects/p1/stats', tab: 'Stats' },
];

/**
 * The Project shell owns one content container, so switching tabs never moves
 * the content sideways. Loading and error states use that same container, so
 * measuring it needs no API fixtures.
 */
test('every project tab starts at the same left content edge', async ({ page }) => {
  const edges: Array<{ tab: string; x: number }> = [];

  for (const { path, tab } of TABS) {
    await page.goto(path);
    const container = page.locator('#main-content > div').first();
    await expect(container, `${tab} renders one content container`).toBeVisible();
    const box = await container.boundingBox();
    expect(box, `${tab} content container has a layout box`).not.toBeNull();
    edges.push({ tab, x: box?.x ?? Number.NaN });
  }

  const [overview, ...others] = edges;
  for (const edge of others) {
    expect(
      Math.abs(edge.x - overview.x),
      `${edge.tab} starts at ${edge.x}px, Overview at ${overview.x}px`,
    ).toBeLessThanOrEqual(1);
  }
});
