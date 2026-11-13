import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActivePath } from './navigation';

describe('NAV_ITEMS', () => {
  it('uses unique, absolute hrefs', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(href.startsWith('/')).toBe(true);
    }
  });
});

describe('isActivePath', () => {
  it('matches a route and its nested paths', () => {
    expect(isActivePath('/settings', '/settings')).toBe(true);
    expect(isActivePath('/settings/keys', '/settings')).toBe(true);
  });

  it('keeps the index route from matching everything', () => {
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/settings', '/')).toBe(false);
  });

  it('does not match unrelated routes', () => {
    expect(isActivePath('/projects/new', '/settings')).toBe(false);
  });
});
