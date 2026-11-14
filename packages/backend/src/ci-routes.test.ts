import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

async function request(
  context: TestContext,
  path: string,
  init: RequestInit = {},
  session?: string,
): Promise<Response> {
  return context.app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { cookie: `${SESSION_COOKIE}=${session}` }),
      ...init.headers,
    },
  });
}

describe('GET /api/admin/ci/status', () => {
  it('rejects an unauthenticated request', async () => {
    const context = createTestContext();

    const res = await request(context, '/api/admin/ci/status');

    expect(res.status).toBe(401);
  });

  it('reports the tracker status', async () => {
    const context = createTestContext();
    const session = await signIn(context);

    const res = await request(context, '/api/admin/ci/status', {}, session);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      enabled: true,
      intervalMs: 30_000,
      lastCheckedAt: null,
      watches: [],
    });
  });
});

describe('PATCH /api/admin/ci/config', () => {
  it('updates the enabled flag and interval', async () => {
    const context = createTestContext();
    const session = await signIn(context);

    const res = await request(
      context,
      '/api/admin/ci/config',
      { method: 'PATCH', body: JSON.stringify({ enabled: false, intervalMs: 60_000 }) },
      session,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ enabled: false, intervalMs: 60_000 });
  });

  it('rejects an interval outside the accepted range', async () => {
    const context = createTestContext();
    const session = await signIn(context);

    const res = await request(
      context,
      '/api/admin/ci/config',
      { method: 'PATCH', body: JSON.stringify({ intervalMs: 10 }) },
      session,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });
});
