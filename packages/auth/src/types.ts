/**
 * Public domain types for the Auth Module.
 *
 * YAAABK is single-user per instance: one Developer account, protected by a
 * password and a required TOTP second factor. These types describe that
 * account, its sessions, and the store the module persists them through.
 *
 * Timestamps are ISO-8601 UTC strings: SQLite stores them as TEXT and, because
 * ISO-8601 is lexicographically ordered, expiry comparisons are plain string
 * comparisons.
 */

/** A Developer account with no secrets, safe to hand to the UI. */
export interface PublicUser {
  id: string;
  username: string;
}

/** A Developer account as persisted, including the password and TOTP secrets. */
export interface UserRecord extends PublicUser {
  /** bcrypt digest. Never the plaintext password. */
  passwordHash: string;
  /** Base32 TOTP secret. */
  totpSecret: string;
  /** False until the Developer has proved they scanned the secret. */
  totpVerified: boolean;
  createdAt: string;
}

/** An authenticated session as persisted. */
export interface SessionRecord {
  id: string;
  userId: string;
  /** SHA-256 of the session JWT, so the raw token is never stored. */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * The persistence port the Auth Module is built on.
 *
 * Deliberately synchronous: the production adapter is `bun:sqlite`, which is
 * synchronous, and the in-memory fake is too. Tests inject
 * {@link createInMemoryAuthStore}; the backend injects the SQLite adapter.
 */
export interface AuthStore {
  /** How many accounts have completed TOTP verification. */
  countVerifiedUsers(): number;
  createUser(user: UserRecord): void;
  getUser(id: string): UserRecord | undefined;
  getUserByUsername(username: string): UserRecord | undefined;
  /** Records that the Developer has verified their TOTP secret. */
  markTotpVerified(id: string): void;
  /** Removes accounts that never finished setup, so setup can be retried. */
  deleteUnverifiedUsers(): void;

  createSession(session: SessionRecord): void;
  getSessionByTokenHash(tokenHash: string): SessionRecord | undefined;
  deleteSession(id: string): void;
  /** Removes every session whose `expiresAt` is at or before `now`. */
  deleteExpiredSessions(now: string): void;
}

/** The kinds of failure an Auth Module command can report. */
export type AuthErrorKind =
  | 'invalid-input'
  | 'weak-password'
  | 'setup-complete'
  | 'setup-incomplete'
  | 'invalid-credentials'
  | 'invalid-totp'
  | 'invalid-session'
  | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface AuthError {
  kind: AuthErrorKind;
  /** The operation that failed, e.g. `login`. */
  operation: string;
  message: string;
}

/** The result of an Auth Module command: either a value or a typed error. */
export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthError };

/** Whether first-run setup has produced a verified Developer account. */
export interface SetupStatus {
  setupComplete: boolean;
}

/** What `beginSetup` hands back so the UI can render the QR code and confirm. */
export interface SetupChallenge {
  /** Short-lived token proving this browser began setup. */
  setupToken: string;
  /** `otpauth://` URI to render as a QR code. */
  otpauthUri: string;
  /** Base32 secret, for manual entry when scanning is not possible. */
  secret: string;
}

/** What a successful password check hands back before the second factor. */
export interface LoginChallenge {
  /** Short-lived token to present with the TOTP code. */
  pendingToken: string;
}

/** A signed-in session. */
export interface AuthSession {
  /** The JWT to store in the session cookie. */
  sessionToken: string;
  /** ISO-8601 UTC expiry. */
  expiresAt: string;
  user: PublicUser;
}

/**
 * The Auth Module's public contract.
 *
 * Every command resolves to an {@link AuthResult}; callers branch on `ok`
 * instead of catching exceptions, matching the other YAAABK modules.
 */
export interface AuthModule {
  /** Whether setup is complete and whether the caller is signed in. */
  status(): Promise<SetupStatus>;
  /** Creates the (unverified) admin account and its TOTP secret. */
  beginSetup(input: { username: string; password: string }): Promise<AuthResult<SetupChallenge>>;
  /** Confirms the TOTP code, completing setup and signing the Developer in. */
  verifySetup(input: { setupToken: string; token: string }): Promise<AuthResult<AuthSession>>;
  /** Checks the password; on success returns a challenge for the second factor. */
  login(input: { username: string; password: string }): Promise<AuthResult<LoginChallenge>>;
  /** Checks the TOTP code and signs the Developer in. */
  verifyTwoFactor(input: { pendingToken: string; token: string }): Promise<AuthResult<AuthSession>>;
  /** Resolves the session's user, or fails with an `invalid-session` error. */
  authenticate(sessionToken: string): Promise<AuthResult<PublicUser>>;
  /** Revokes the session. Idempotent. */
  logout(sessionToken: string): Promise<AuthResult<void>>;
}
