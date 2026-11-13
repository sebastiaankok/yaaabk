import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/** Sessions live for seven days, per the Auth Module specification. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A password has been verified but the second factor has not, yet. */
export const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;

/** How long a Developer has to scan the QR code and confirm a code. */
export const DEFAULT_SETUP_TTL_MS = 15 * 60 * 1000;

/** Minimum length of the HS256 signing secret. */
export const MIN_SECRET_LENGTH = 32;

/** Distinguishes the token kinds so one can never be replayed as another. */
type Purpose = 'session' | 'pending' | 'setup';

export interface SessionClaims {
  userId: string;
  sessionId: string;
}

export interface PendingClaims {
  userId: string;
}

export interface TokenServiceOptions {
  /** HS256 signing secret. Must be at least {@link MIN_SECRET_LENGTH} characters. */
  secret: string;
  /** Defaults to {@link DEFAULT_SESSION_TTL_MS}. */
  sessionTtlMs?: number;
  /** Defaults to {@link DEFAULT_PENDING_TTL_MS}. */
  pendingTtlMs?: number;
  /** Defaults to {@link DEFAULT_SETUP_TTL_MS}. */
  setupTtlMs?: number;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Signs and verifies the JWTs the Auth Module issues, and hashes tokens for
 * storage.
 *
 * Session tokens are stateless JWTs, but the module still records a hash of
 * each one so logout can revoke it before its expiry.
 */
export interface TokenService {
  /** Lifetime of a session token in milliseconds. */
  readonly sessionTtlMs: number;
  signSession(claims: SessionClaims): Promise<string>;
  /** Resolves the claims, or `undefined` when the token is invalid or expired. */
  verifySession(token: string): Promise<SessionClaims | undefined>;
  signPending(claims: PendingClaims): Promise<string>;
  verifyPending(token: string): Promise<PendingClaims | undefined>;
  /** Setup tokens authorise completing the first-run wizard. */
  signSetup(claims: PendingClaims): Promise<string>;
  verifySetup(token: string): Promise<PendingClaims | undefined>;
  /** SHA-256 hex digest, used as the session store's lookup key. */
  hash(token: string): string;
}

/** Builds the token service. */
export function createTokenService(options: TokenServiceOptions): TokenService {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Token secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const key = new TextEncoder().encode(options.secret);
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const setupTtlMs = options.setupTtlMs ?? DEFAULT_SETUP_TTL_MS;

  async function sign(
    purpose: Purpose,
    claims: Record<string, unknown>,
    ttlMs: number,
  ): Promise<string> {
    const issuedAt = now().getTime();
    return new SignJWT({ purpose, ...claims })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .setExpirationTime(Math.floor((issuedAt + ttlMs) / 1000))
      .sign(key);
  }

  async function verify(
    purpose: Purpose,
    token: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        currentDate: now(),
      });
      return payload.purpose === purpose ? payload : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    sessionTtlMs,
    signSession: (claims) =>
      sign('session', { userId: claims.userId, sessionId: claims.sessionId }, sessionTtlMs),
    async verifySession(token) {
      const payload = await verify('session', token);
      if (typeof payload?.userId !== 'string' || typeof payload.sessionId !== 'string') {
        return undefined;
      }
      return { userId: payload.userId, sessionId: payload.sessionId };
    },
    signPending: (claims) => sign('pending', { userId: claims.userId }, pendingTtlMs),
    async verifyPending(token) {
      const payload = await verify('pending', token);
      return typeof payload?.userId === 'string' ? { userId: payload.userId } : undefined;
    },
    signSetup: (claims) => sign('setup', { userId: claims.userId }, setupTtlMs),
    async verifySetup(token) {
      const payload = await verify('setup', token);
      return typeof payload?.userId === 'string' ? { userId: payload.userId } : undefined;
    },
    hash: (token) => createHash('sha256').update(token).digest('hex'),
  };
}
