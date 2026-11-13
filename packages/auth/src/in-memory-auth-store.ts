import type { AuthStore, SessionRecord, UserRecord } from './types';

/** Thrown when a username is already taken; SQLite surfaces the same via UNIQUE. */
export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already taken`);
    this.name = 'DuplicateUsernameError';
  }
}

/**
 * A dependency-free {@link AuthStore} for tests and for other modules that need
 * the Auth Module without a database file.
 */
export function createInMemoryAuthStore(): AuthStore {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();

  function requireUser(id: string): UserRecord {
    const user = users.get(id);
    if (user === undefined) {
      throw new Error(`No user with id "${id}"`);
    }
    return user;
  }

  return {
    countVerifiedUsers: () => [...users.values()].filter((user) => user.totpVerified).length,

    createUser(user) {
      for (const existing of users.values()) {
        if (existing.username === user.username) {
          throw new DuplicateUsernameError(user.username);
        }
      }
      users.set(user.id, { ...user });
    },

    getUser: (id) => {
      const user = users.get(id);
      return user === undefined ? undefined : { ...user };
    },

    getUserByUsername: (username) => {
      for (const user of users.values()) {
        if (user.username === username) {
          return { ...user };
        }
      }
      return undefined;
    },

    markTotpVerified(id) {
      requireUser(id).totpVerified = true;
    },

    deleteUnverifiedUsers() {
      for (const [id, user] of users) {
        if (!user.totpVerified) {
          users.delete(id);
        }
      }
    },

    createSession: (session) => {
      sessions.set(session.id, { ...session });
    },

    getSessionByTokenHash: (tokenHash) => {
      for (const session of sessions.values()) {
        if (session.tokenHash === tokenHash) {
          return { ...session };
        }
      }
      return undefined;
    },

    deleteSession: (id) => {
      sessions.delete(id);
    },

    deleteExpiredSessions(now) {
      for (const [id, session] of sessions) {
        if (session.expiresAt <= now) {
          sessions.delete(id);
        }
      }
    },
  };
}
