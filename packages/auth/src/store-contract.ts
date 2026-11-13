import type { AuthStore, SessionRecord, UserRecord } from './types';

/**
 * The minimal test-framework surface the store contract needs.
 *
 * Declaring it structurally lets the same suite run under both vitest (the
 * in-memory store) and `bun:test` (the SQLite store), so the two adapters are
 * held to identical behaviour without duplicating the assertions.
 */
export interface StoreTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void): void;
  expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toThrow(): void;
  };
}

/** A complete {@link UserRecord}, overridable per test. */
export function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    username: 'alice',
    passwordHash: 'hash',
    totpSecret: 'SECRET',
    totpVerified: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete {@link SessionRecord}, overridable per test. */
export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    tokenHash: 'token-hash',
    expiresAt: '2026-01-08T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Asserts that an {@link AuthStore} implementation behaves as specified.
 *
 * Callers pass their framework's `describe`/`it`/`expect` and a factory that
 * returns a fresh, empty store.
 */
export function authStoreContract(api: StoreTestApi, createStore: () => AuthStore): void {
  const { describe, it, expect } = api;

  describe('users', () => {
    it('starts with no verified users', () => {
      expect(createStore().countVerifiedUsers()).toBe(0);
    });

    it('stores and reads back a user by id', () => {
      const store = createStore();
      store.createUser(userRecord());

      expect(store.getUser('user-1')).toEqual(userRecord());
    });

    it('finds a user by username', () => {
      const store = createStore();
      store.createUser(userRecord());

      expect(store.getUserByUsername('alice')).toEqual(userRecord());
    });

    it('returns undefined for unknown users', () => {
      const store = createStore();

      expect(store.getUser('missing')).toBeUndefined();
      expect(store.getUserByUsername('missing')).toBeUndefined();
    });

    it('rejects a duplicate username', () => {
      const store = createStore();
      store.createUser(userRecord());

      expect(() => store.createUser(userRecord({ id: 'user-2' }))).toThrow();
    });

    it('marks a user verified, raising the verified count', () => {
      const store = createStore();
      store.createUser(userRecord());

      store.markTotpVerified('user-1');

      expect(store.getUser('user-1')?.totpVerified).toBe(true);
      expect(store.countVerifiedUsers()).toBe(1);
    });

    it('deletes only unverified users', () => {
      const store = createStore();
      store.createUser(userRecord({ id: 'unverified', username: 'bob' }));
      store.createUser(userRecord({ id: 'verified', username: 'carol', totpVerified: true }));

      store.deleteUnverifiedUsers();

      expect(store.getUserByUsername('bob')).toBeUndefined();
      expect(store.getUserByUsername('carol')).toEqual(
        userRecord({ id: 'verified', username: 'carol', totpVerified: true }),
      );
    });
  });

  describe('sessions', () => {
    it('stores and reads back a session by token hash', () => {
      const store = createStore();
      store.createUser(userRecord());
      store.createSession(sessionRecord());

      expect(store.getSessionByTokenHash('token-hash')).toEqual(sessionRecord());
    });

    it('returns undefined for an unknown token hash', () => {
      expect(createStore().getSessionByTokenHash('missing')).toBeUndefined();
    });

    it('deletes a session by id', () => {
      const store = createStore();
      store.createUser(userRecord());
      store.createSession(sessionRecord());

      store.deleteSession('session-1');

      expect(store.getSessionByTokenHash('token-hash')).toBeUndefined();
    });

    it('deletes only the sessions that have expired', () => {
      const store = createStore();
      store.createUser(userRecord());
      store.createSession(
        sessionRecord({
          id: 'expired',
          tokenHash: 'expired',
          expiresAt: '2026-01-02T00:00:00.000Z',
        }),
      );
      store.createSession(
        sessionRecord({ id: 'live', tokenHash: 'live', expiresAt: '2026-01-09T00:00:00.000Z' }),
      );

      store.deleteExpiredSessions('2026-01-05T00:00:00.000Z');

      expect(store.getSessionByTokenHash('expired')).toBeUndefined();
      expect(store.getSessionByTokenHash('live')).toBeDefined();
    });
  });
}
