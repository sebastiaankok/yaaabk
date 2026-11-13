import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { cookieValue, createTestContext, signIn, TEST_CODE, TEST_PASSWORD } from './test-support';

const USERNAME = 'alice';

function post(
  app: ReturnType<typeof createTestContext>['app'],
  path: string,
  body: unknown,
  cookie?: string,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` }),
    },
    body: JSON.stringify(body),
  });
}

describe('GET /api/auth/status', () => {
  it('reports a fresh instance as unconfigured and signed out', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/auth/status');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ setupComplete: false, authenticated: false });
  });
});

describe('POST /api/auth/setup', () => {
  it('rejects a weak password', async () => {
    const { app } = createTestContext();

    const res = await post(app, '/api/auth/setup', { username: USERNAME, password: 'password' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'weak-password' });
  });

  it('returns an otpauth URI and a setup token', async () => {
    const { app } = createTestContext();

    const res = await post(app, '/api/auth/setup', { username: USERNAME, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { setupToken: string; otpauthUri: string };
    expect(body.setupToken.length).toBeGreaterThan(0);
    expect(body.otpauthUri).toContain('alice');
  });
});

describe('POST /api/auth/setup/verify', () => {
  it('rejects a wrong code without setting a cookie', async () => {
    const { app } = createTestContext();
    const setup = await post(app, '/api/auth/setup', {
      username: USERNAME,
      password: TEST_PASSWORD,
    });
    const { setupToken } = (await setup.json()) as { setupToken: string };

    const res = await post(app, '/api/auth/setup/verify', { setupToken, token: '000000' });

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs the Developer in with a hardened session cookie', async () => {
    const { app } = createTestContext();
    const setup = await post(app, '/api/auth/setup', {
      username: USERNAME,
      password: TEST_PASSWORD,
    });
    const { setupToken } = (await setup.json()) as { setupToken: string };

    const res = await post(app, '/api/auth/setup/verify', { setupToken, token: TEST_CODE });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      user: { id: expect.any(String), username: USERNAME },
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const status = await app.request('/api/auth/status', {
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue(res, SESSION_COOKIE)}` },
    });
    await expect(status.json()).resolves.toMatchObject({
      setupComplete: true,
      authenticated: true,
    });
  });
});

describe('POST /api/auth/login', () => {
  it('is refused until setup is complete', async () => {
    const { app } = createTestContext();

    const res = await post(app, '/api/auth/login', { username: USERNAME, password: TEST_PASSWORD });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'setup-incomplete' });
  });

  it('reports a wrong password and an unknown user identically', async () => {
    const context = createTestContext();
    await signIn(context);

    const wrongPassword = await post(context.app, '/api/auth/login', {
      username: USERNAME,
      password: 'wR0ng!Password99',
    });
    const unknownUser = await post(context.app, '/api/auth/login', {
      username: 'nobody',
      password: TEST_PASSWORD,
    });

    expect(wrongPassword.status).toBe(401);
    await expect(wrongPassword.json()).resolves.toEqual(await unknownUser.json());
  });

  it('returns a second-factor challenge for correct credentials', async () => {
    const context = createTestContext();
    await signIn(context);

    const res = await post(context.app, '/api/auth/login', {
      username: USERNAME,
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pendingToken: string };
    expect(body.pendingToken.length).toBeGreaterThan(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/auth/login/2fa', () => {
  it('rejects a wrong code', async () => {
    const context = createTestContext();
    await signIn(context);
    const login = await post(context.app, '/api/auth/login', {
      username: USERNAME,
      password: TEST_PASSWORD,
    });
    const { pendingToken } = (await login.json()) as { pendingToken: string };

    const res = await post(context.app, '/api/auth/login/2fa', { pendingToken, token: '000000' });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-totp' });
  });

  it('signs the Developer in for a correct code', async () => {
    const context = createTestContext();
    await signIn(context);
    const login = await post(context.app, '/api/auth/login', {
      username: USERNAME,
      password: TEST_PASSWORD,
    });
    const { pendingToken } = (await login.json()) as { pendingToken: string };

    const res = await post(context.app, '/api/auth/login/2fa', { pendingToken, token: TEST_CODE });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie and revokes the session', async () => {
    const context = createTestContext();
    const session = await signIn(context);

    const res = await post(context.app, '/api/auth/logout', {}, session);

    expect(res.status).toBe(200);
    const cleared = res.headers.get('set-cookie') ?? '';
    expect(cleared).toContain('Max-Age=0');

    const status = await context.app.request('/api/auth/status', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    await expect(status.json()).resolves.toMatchObject({ authenticated: false });
  });
});

describe('CORS', () => {
  it('allows the web origin to call the API with credentials', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('rate limiting', () => {
  it('blocks a sixth credential attempt but not status reads', async () => {
    const context = createTestContext({ attemptsPerMinute: 5 });
    await signIn(context);

    const attempt = () =>
      post(context.app, '/api/auth/login', { username: USERNAME, password: 'wrong' });
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({ error: 'rate-limited' });

    for (let i = 0; i < 6; i += 1) {
      expect((await context.app.request('/api/auth/status')).status).toBe(200);
    }
  });
});
