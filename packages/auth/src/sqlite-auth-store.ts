import { DuplicateUsernameError } from './in-memory-auth-store';
import type { AuthStore, SessionRecord, UserRecord } from './types';

/**
 * The slice of a SQLite driver the store uses.
 *
 * Keeping it structural (rather than importing `bun:sqlite`) lets the adapter
 * be typed without Bun types and passed a real `bun:sqlite` `Database` from the
 * backend.
 */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string;
  totp_verified: number;
  created_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT NOT NULL,
  totp_verified INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
`;

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpVerified: row.totp_verified === 1,
    createdAt: row.created_at,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function isUniqueUsernameViolation(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('UNIQUE') && error.message.includes('username')
  );
}

/**
 * Builds the production {@link AuthStore} on a SQLite database.
 *
 * The caller owns the database handle (the backend opens it with `bun:sqlite`);
 * the store only creates its tables and issues statements.
 */
export function createSqliteAuthStore(database: SqliteDatabase): AuthStore {
  database.exec(SCHEMA);

  return {
    countVerifiedUsers() {
      const row = database
        .prepare('SELECT COUNT(*) AS count FROM users WHERE totp_verified = 1')
        .get() as { count: number };
      return row.count;
    },

    createUser(user) {
      try {
        database
          .prepare(
            `INSERT INTO users (id, username, password_hash, totp_secret, totp_verified, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            user.id,
            user.username,
            user.passwordHash,
            user.totpSecret,
            user.totpVerified ? 1 : 0,
            user.createdAt,
          );
      } catch (error) {
        if (isUniqueUsernameViolation(error)) {
          throw new DuplicateUsernameError(user.username);
        }
        throw error;
      }
    },

    getUser(id) {
      const row = database.prepare('SELECT * FROM users WHERE id = ?').get(id) as
        UserRow | null | undefined;
      return row == null ? undefined : toUser(row);
    },

    getUserByUsername(username) {
      const row = database.prepare('SELECT * FROM users WHERE username = ?').get(username) as
        UserRow | null | undefined;
      return row == null ? undefined : toUser(row);
    },

    markTotpVerified(id) {
      database.prepare('UPDATE users SET totp_verified = 1 WHERE id = ?').run(id);
    },

    deleteUnverifiedUsers() {
      database.prepare('DELETE FROM users WHERE totp_verified = 0').run();
    },

    createSession(session) {
      database
        .prepare(
          `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt);
    },

    getSessionByTokenHash(tokenHash) {
      const row = database.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
        SessionRow | null | undefined;
      return row == null ? undefined : toSession(row);
    },

    deleteSession(id) {
      database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    },

    deleteExpiredSessions(now) {
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    },
  };
}
