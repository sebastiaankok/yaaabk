import { describe, expect, it } from 'vitest';
import { createAuthModule } from './auth';
import { createFakePasswordHasher } from './fake-password-hasher';
import { createFakeTotp } from './fake-totp';
import { createInMemoryAuthStore } from './in-memory-auth-store';
import { createPasswordPolicy } from './password';
import { createTokenService, MIN_SECRET_LENGTH } from './token';
import type { AuthModule } from './types';

const T0 = Date.UTC(2026, 0, 1, 12);
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const STRONG_PASSWORD = 'vX7$qmPz2!Lw9Rt';
const VALID_CODE = '123456';
const USERNAME = 'alice';

const silent = { info: () => {}, error: () => {} };

function harness() {
  const clock = { ms: T0 };
  const store = createInMemoryAuthStore();
  const tokens = createTokenService({
    secret: 'x'.repeat(MIN_SECRET_LENGTH),
    now: () => new Date(clock.ms),
  });
  const auth = createAuthModule({
    store,
    tokens,
    hasher: createFakePasswordHasher(),
    totp: createFakeTotp(),
    policy: createPasswordPolicy(),
    now: () => new Date(clock.ms),
    logger: silent,
  });
  return { auth, store, clock };
}

/** Runs setup to completion and returns the resulting session. */
async function completeSetup(auth: AuthModule) {
  const begun = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });
  expect(begun.ok).toBe(true);
  if (!begun.ok) throw new Error('unreachable');
  const verified = await auth.verifySetup({
    setupToken: begun.value.setupToken,
    token: VALID_CODE,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error('unreachable');
  return verified.value;
}

describe('status', () => {
  it('reports setup as incomplete on a fresh instance', async () => {
    const { auth } = harness();

    await expect(auth.status()).resolves.toEqual({ setupComplete: false });
  });

  it('reports setup as complete once a verified account exists', async () => {
    const { auth } = harness();
    await completeSetup(auth);

    await expect(auth.status()).resolves.toEqual({ setupComplete: true });
  });
});

describe('beginSetup', () => {
  it('rejects an empty username', async () => {
    const { auth } = harness();

    const result = await auth.beginSetup({ username: '   ', password: STRONG_PASSWORD });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-input');
  });

  it('rejects a weak password and explains why', async () => {
    const { auth } = harness();

    const result = await auth.beginSetup({ username: USERNAME, password: 'password' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('weak-password');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('returns a scannable otpauth URI for the chosen username', async () => {
    const { auth } = harness();

    const result = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.otpauthUri).toContain('alice');
      expect(result.value.secret.length).toBeGreaterThan(0);
    }
  });

  it('never stores the plaintext password', async () => {
    const { auth, store } = harness();
    await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });

    const stored = store.getUserByUsername(USERNAME);

    expect(stored?.passwordHash).toBeDefined();
    expect(stored?.passwordHash).not.toBe(STRONG_PASSWORD);
    expect(stored?.totpVerified).toBe(false);
  });

  it('replaces an unfinished setup instead of stacking accounts', async () => {
    const { auth, store } = harness();
    const first = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });
    const second = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });
    expect(first.ok && second.ok).toBe(true);

    const users = store.getUserByUsername(USERNAME);
    expect(users).toBeDefined();

    if (first.ok) {
      const stale = await auth.verifySetup({
        setupToken: first.value.setupToken,
        token: VALID_CODE,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.kind).toBe('invalid-session');
    }
  });

  it('is refused once setup is complete', async () => {
    const { auth } = harness();
    await completeSetup(auth);

    const result = await auth.beginSetup({ username: 'bob', password: STRONG_PASSWORD });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('setup-complete');
  });
});

describe('verifySetup', () => {
  it('signs the Developer in on a valid code', async () => {
    const { auth } = harness();
    const started = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = await auth.verifySetup({
      setupToken: started.value.setupToken,
      token: VALID_CODE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.user).toEqual({ id: expect.any(String), username: USERNAME });
      await expect(auth.authenticate(result.value.sessionToken)).resolves.toEqual({
        ok: true,
        value: { id: result.value.user.id, username: USERNAME },
      });
    }
  });

  it('rejects a wrong code and leaves setup incomplete', async () => {
    const { auth } = harness();
    const started = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });
    if (!started.ok) return;

    const result = await auth.verifySetup({
      setupToken: started.value.setupToken,
      token: '000000',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-totp');
    await expect(auth.status()).resolves.toEqual({ setupComplete: false });
  });

  it('rejects an unknown setup token', async () => {
    const { auth } = harness();

    const result = await auth.verifySetup({ setupToken: 'not-a-token', token: VALID_CODE });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-session');
  });

  it('rejects a setup token once it has expired', async () => {
    const { auth, clock } = harness();
    const started = await auth.beginSetup({ username: USERNAME, password: STRONG_PASSWORD });
    if (!started.ok) return;
    clock.ms = T0 + 16 * 60 * 1000;

    const result = await auth.verifySetup({
      setupToken: started.value.setupToken,
      token: VALID_CODE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-session');
  });
});

describe('login', () => {
  it('is refused until setup is complete', async () => {
    const { auth } = harness();

    const result = await auth.login({ username: USERNAME, password: STRONG_PASSWORD });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('setup-incomplete');
  });

  it('returns a second-factor challenge for correct credentials', async () => {
    const { auth } = harness();
    await completeSetup(auth);

    const result = await auth.login({ username: USERNAME, password: STRONG_PASSWORD });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pendingToken.length).toBeGreaterThan(0);
  });

  it('reports an unknown username exactly like a wrong password', async () => {
    const { auth } = harness();
    await completeSetup(auth);

    const wrongPassword = await auth.login({ username: USERNAME, password: 'wR0ng!Password99' });
    const unknownUser = await auth.login({ username: 'nobody', password: STRONG_PASSWORD });

    expect(wrongPassword).toEqual(unknownUser);
    expect(wrongPassword.ok).toBe(false);
    if (!wrongPassword.ok) expect(wrongPassword.error.kind).toBe('invalid-credentials');
  });
});

describe('verifyTwoFactor', () => {
  it('signs the Developer in with a session on a valid code', async () => {
    const { auth } = harness();
    await completeSetup(auth);
    const challenge = await auth.login({ username: USERNAME, password: STRONG_PASSWORD });
    if (!challenge.ok) return;

    const result = await auth.verifyTwoFactor({
      pendingToken: challenge.value.pendingToken,
      token: VALID_CODE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expiresAt).toBe(new Date(T0 + SEVEN_DAYS).toISOString());
    }
  });

  it('rejects a wrong code without creating a session', async () => {
    const { auth } = harness();
    await completeSetup(auth);
    const challenge = await auth.login({ username: USERNAME, password: STRONG_PASSWORD });
    if (!challenge.ok) return;

    const result = await auth.verifyTwoFactor({
      pendingToken: challenge.value.pendingToken,
      token: '000000',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-totp');
  });

  it('rejects a challenge that has expired', async () => {
    const { auth, clock } = harness();
    await completeSetup(auth);
    const challenge = await auth.login({ username: USERNAME, password: STRONG_PASSWORD });
    if (!challenge.ok) return;
    clock.ms = T0 + 6 * 60 * 1000;

    const result = await auth.verifyTwoFactor({
      pendingToken: challenge.value.pendingToken,
      token: VALID_CODE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-session');
  });
});

describe('authenticate', () => {
  it('rejects an unknown token', async () => {
    const { auth } = harness();

    const result = await auth.authenticate('not-a-token');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-session');
  });

  it('rejects a session once it has expired', async () => {
    const { auth, clock } = harness();
    const session = await completeSetup(auth);
    clock.ms = T0 + SEVEN_DAYS;

    const result = await auth.authenticate(session.sessionToken);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-session');
  });
});

describe('logout', () => {
  it('revokes the session', async () => {
    const { auth } = harness();
    const session = await completeSetup(auth);

    await auth.logout(session.sessionToken);

    const result = await auth.authenticate(session.sessionToken);
    expect(result.ok).toBe(false);
  });

  it('is idempotent for an unknown token', async () => {
    const { auth } = harness();

    await expect(auth.logout('not-a-token')).resolves.toEqual({ ok: true, value: undefined });
  });
});
