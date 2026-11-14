import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

async function request(
  context: TestContext,
  session: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return context.app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${session}`,
      ...init.headers,
    },
  });
}

async function signedIn(): Promise<{ context: TestContext; session: string }> {
  const context = createTestContext();
  const session = await signIn(context);
  return { context, session };
}

describe('GET /api/settings', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/settings');

    expect(res.status).toBe(401);
  });

  it('returns the masked settings view', async () => {
    const { context, session } = await signedIn();
    await context.settings.update({ openrouterManagementKey: 'sk-or-v1-abcdefgh1c96' });

    const res = await request(context, session, '/api/settings');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      openrouterManagementKey: 'sk-or-…1c96',
    });
  });
});

describe('PUT /api/settings', () => {
  it('stores a credential and returns the masked view', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ openrouter_management_key: 'sk-or-v1-abcdefgh1c96' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      openrouterManagementKey: 'sk-or-…1c96',
    });
  });

  it('rejects an out-of-range default budget with 400', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ default_issue_budget_cents: 501 }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });
});

describe('POST /api/settings/openrouter/verify', () => {
  it('reports the resolved account for the stored management key', async () => {
    const { context, session } = await signedIn();
    await context.settings.update({ openrouterManagementKey: 'sk-or-v1-abcdefgh1c96' });

    const res = await request(context, session, '/api/settings/openrouter/verify', { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, keys: 3 });
  });

  it('reports unauthorized instead of a 500 when no key is configured', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/settings/openrouter/verify', { method: 'POST' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' });
  });
});

describe('POST /api/settings/github/verify', () => {
  it('reports the resolved account for the stored credentials', async () => {
    const { context, session } = await signedIn();
    await context.settings.update({ githubPat: 'ghp_originalvalue1234' });

    const res = await request(context, session, '/api/settings/github/verify', { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, kind: 'pat', account: 'octocat' });
  });

  it('reports unauthorized when no GitHub credentials are configured', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/settings/github/verify', { method: 'POST' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' });
  });
});
