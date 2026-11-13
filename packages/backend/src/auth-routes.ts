import {
  createRateLimiter,
  type AuthError,
  type AuthModule,
  type AuthSession,
  type RateLimiter,
} from '@yaaabk/auth';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Name of the HTTP-only cookie holding the session JWT. */
export const SESSION_COOKIE = 'yaaabk_session';

/** Attempts each credential endpoint accepts per window, per client. */
export const DEFAULT_ATTEMPTS_PER_MINUTE = 5;

const RATE_LIMITED_MESSAGE = 'Too many attempts; please wait a minute and try again.';

const STATUS_BY_KIND: Record<AuthError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'weak-password': 400,
  'setup-complete': 409,
  'setup-incomplete': 409,
  'invalid-credentials': 401,
  'invalid-totp': 401,
  'invalid-session': 401,
  unknown: 500,
};

export interface AuthRoutesOptions {
  /** Attempts allowed per minute. Defaults to {@link DEFAULT_ATTEMPTS_PER_MINUTE}. */
  attemptsPerMinute?: number;
  /** Marks the session cookie `Secure`. Defaults to false for local HTTP. */
  secureCookies?: boolean;
  /** Injectable for tests. Defaults to an in-memory limiter. */
  rateLimiter?: RateLimiter;
}

function clientKey(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : 'local';
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Builds the session cookie options for a freshly minted session. */
function sessionCookie(session: AuthSession, secure: boolean) {
  const seconds = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
  return {
    httpOnly: true,
    sameSite: 'Strict',
    secure,
    path: '/',
    maxAge: seconds,
  } as const;
}

function fail(c: Context, error: AuthError) {
  return c.json({ error: error.kind, message: error.message }, STATUS_BY_KIND[error.kind]);
}

/**
 * Builds the `/api/auth/*` routes.
 *
 * Credential endpoints (setup, its verification, login and its second factor)
 * plus logout are rate-limited; the read-only status endpoint is not, so the UI
 * can poll it freely.
 */
export function authRoutes(auth: AuthModule, options: AuthRoutesOptions = {}): Hono {
  const secure = options.secureCookies ?? false;
  const rateLimiter =
    options.rateLimiter ??
    createRateLimiter({ limit: options.attemptsPerMinute ?? DEFAULT_ATTEMPTS_PER_MINUTE });

  const app = new Hono();

  app.use('/api/auth/*', async (c, next) => {
    // Only credential submissions count as attempts; reads and CORS preflights
    // are free.
    if (c.req.method !== 'POST') {
      await next();
      return;
    }
    if (!rateLimiter.check(`${clientKey(c)}:${c.req.path}`)) {
      return c.json({ error: 'rate-limited', message: RATE_LIMITED_MESSAGE }, 429);
    }
    await next();
  });

  app.get('/api/auth/status', async (c) => {
    const status = await auth.status();
    const token = getCookie(c, SESSION_COOKIE);
    const result = token === undefined ? undefined : await auth.authenticate(token);
    const user = result?.ok ? result.value : undefined;
    return c.json({
      setupComplete: status.setupComplete,
      authenticated: user !== undefined,
      ...(user === undefined ? {} : { user }),
    });
  });

  app.post('/api/auth/setup', async (c) => {
    const input = await body(c);
    const result = await auth.beginSetup({
      username: asString(input.username),
      password: asString(input.password),
    });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/auth/setup/verify', async (c) => {
    const input = await body(c);
    const result = await auth.verifySetup({
      setupToken: asString(input.setupToken),
      token: asString(input.token),
    });
    if (!result.ok) return fail(c, result.error);
    setCookie(c, SESSION_COOKIE, result.value.sessionToken, sessionCookie(result.value, secure));
    return c.json({ user: result.value.user });
  });

  app.post('/api/auth/login', async (c) => {
    const input = await body(c);
    const result = await auth.login({
      username: asString(input.username),
      password: asString(input.password),
    });
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.post('/api/auth/login/2fa', async (c) => {
    const input = await body(c);
    const result = await auth.verifyTwoFactor({
      pendingToken: asString(input.pendingToken),
      token: asString(input.token),
    });
    if (!result.ok) return fail(c, result.error);
    setCookie(c, SESSION_COOKIE, result.value.sessionToken, sessionCookie(result.value, secure));
    return c.json({ user: result.value.user });
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) {
      await auth.logout(token);
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Rejects unauthenticated requests to everything under `/api`, except the
 * `/api/auth/*` routes the login flow itself needs.
 */
export function requireAuth(auth: AuthModule): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) {
      await next();
      return;
    }
    const token = getCookie(c, SESSION_COOKIE);
    const result = token === undefined ? undefined : await auth.authenticate(token);
    if (result === undefined || !result.ok) {
      return c.json({ error: 'invalid-session', message: 'You are not signed in' }, 401);
    }
    await next();
  };
}
