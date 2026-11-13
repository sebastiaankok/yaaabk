import { describe, expect, it } from 'vitest';
import { createTokenService, MIN_SECRET_LENGTH } from './token';

const SECRET = 's'.repeat(MIN_SECRET_LENGTH);

/** A fixed instant so expiry assertions are deterministic. */
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

function serviceAt(clock: { ms: number }, secret = SECRET) {
  return createTokenService({ secret, now: () => new Date(clock.ms) });
}

describe('createTokenService', () => {
  it('refuses a secret shorter than the minimum length', () => {
    expect(() => createTokenService({ secret: 'too-short' })).toThrow();
  });
});

describe('session tokens', () => {
  it('round-trip the user and session ids', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const token = await tokens.signSession({ userId: 'user-1', sessionId: 'session-1' });

    await expect(tokens.verifySession(token)).resolves.toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('are rejected once seven days have passed', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);
    const token = await tokens.signSession({ userId: 'user-1', sessionId: 'session-1' });

    clock.ms = T0 + SEVEN_DAYS;

    await expect(tokens.verifySession(token)).resolves.toBeUndefined();
  });

  it('remain valid just before they expire', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);
    const token = await tokens.signSession({ userId: 'user-1', sessionId: 'session-1' });

    clock.ms = T0 + SEVEN_DAYS - 1000;

    await expect(tokens.verifySession(token)).resolves.toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('reject a token signed with a different secret', async () => {
    const clock = { ms: T0 };
    const token = await serviceAt(clock).signSession({ userId: 'u', sessionId: 's' });
    const other = serviceAt(clock, 'different-secret-that-is-long-enough');

    await expect(other.verifySession(token)).resolves.toBeUndefined();
  });

  it('reject a tampered token', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);
    const token = await tokens.signSession({ userId: 'u', sessionId: 's' });

    await expect(tokens.verifySession(`${token}x`)).resolves.toBeUndefined();
  });
});

describe('pending tokens', () => {
  it('round-trip the user id', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const token = await tokens.signPending({ userId: 'user-1' });

    await expect(tokens.verifyPending(token)).resolves.toEqual({ userId: 'user-1' });
  });

  it('expire after five minutes', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);
    const token = await tokens.signPending({ userId: 'user-1' });

    clock.ms = T0 + FIVE_MINUTES;

    await expect(tokens.verifyPending(token)).resolves.toBeUndefined();
  });

  it('cannot be used as a session token', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const pending = await tokens.signPending({ userId: 'user-1' });

    await expect(tokens.verifySession(pending)).resolves.toBeUndefined();
  });

  it('reject a session token used as a pending token', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const session = await tokens.signSession({ userId: 'user-1', sessionId: 'session-1' });

    await expect(tokens.verifyPending(session)).resolves.toBeUndefined();
  });
});

describe('setup tokens', () => {
  it('round-trip the user id', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const token = await tokens.signSetup({ userId: 'user-1' });

    await expect(tokens.verifySetup(token)).resolves.toEqual({ userId: 'user-1' });
  });

  it('cannot be used as a pending or session token', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const setup = await tokens.signSetup({ userId: 'user-1' });

    await expect(tokens.verifyPending(setup)).resolves.toBeUndefined();
    await expect(tokens.verifySession(setup)).resolves.toBeUndefined();
  });

  it('rejects a pending token used as a setup token', async () => {
    const clock = { ms: T0 };
    const tokens = serviceAt(clock);

    const pending = await tokens.signPending({ userId: 'user-1' });

    await expect(tokens.verifySetup(pending)).resolves.toBeUndefined();
  });
});

describe('hash', () => {
  it('is a deterministic sha256 the store can look up', () => {
    const tokens = serviceAt({ ms: T0 });

    expect(tokens.hash('token')).toBe(tokens.hash('token'));
    expect(tokens.hash('token')).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.hash('token')).not.toBe(tokens.hash('other'));
  });
});
