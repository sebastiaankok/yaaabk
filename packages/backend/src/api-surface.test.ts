import { describe, expect, it } from 'vitest';
import { createTestContext } from './test-support';

/**
 * The legacy marker-based grill-me path is gone. These endpoints were its only
 * remaining entry points, so the API surface must not offer them again.
 */
const REMOVED_ROUTES = [
  { method: 'POST', path: '/api/projects/:id/issues/approve' },
  { method: 'POST', path: '/api/projects/:id/issues/generate' },
  { method: 'POST', path: '/api/projects/:id/issues/refine' },
  { method: 'POST', path: '/api/projects/:id/grill/:sessionId/answer' },
  { method: 'POST', path: '/api/projects/:id/grill/:sessionId/refine' },
];

describe('removed grill-me endpoints', () => {
  it.each(REMOVED_ROUTES)('does not expose $method $path', ({ method, path }) => {
    const { app } = createTestContext();

    const exposed = app.routes.some((route) => route.method === method && route.path === path);

    expect(exposed).toBe(false);
  });
});
