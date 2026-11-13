import { randomUUID } from 'node:crypto';
import { authError, consoleLogger, toAuthError, type AuthLogger } from './errors';
import { createBcryptHasher, type PasswordHasher } from './hasher';
import { createPasswordPolicy, type PasswordPolicy } from './password';
import { createTotp, type Totp } from './totp';
import type { TokenService } from './token';
import type {
  AuthModule,
  AuthResult,
  AuthSession,
  AuthStore,
  PublicUser,
  UserRecord,
} from './types';

/**
 * A valid bcrypt digest of a throwaway value.
 *
 * When the username is unknown the module still runs a bcrypt comparison
 * against this, so a request for a missing account takes about as long as one
 * with a wrong password and does not leak which usernames exist.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$B.wCARxkboit7yVhqGwvz.GTbJzknngHPjlAATTbr6UsqD4UpJlby';

export interface AuthModuleOptions {
  store: AuthStore;
  tokens: TokenService;
  /** Defaults to {@link createBcryptHasher}. */
  hasher?: PasswordHasher;
  /** Defaults to {@link createTotp}. */
  totp?: Totp;
  /** Defaults to {@link createPasswordPolicy}. */
  policy?: PasswordPolicy;
  /** Issuer shown in the authenticator app. Used only when `totp` is omitted. */
  totpIssuer?: string;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: AuthLogger;
}

/** Builds the public Auth Module. */
export function createAuthModule(options: AuthModuleOptions): AuthModule {
  const { store, tokens } = options;
  const hasher = options.hasher ?? createBcryptHasher();
  const totp = options.totp ?? createTotp({ issuer: options.totpIssuer });
  const policy = options.policy ?? createPasswordPolicy();
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? consoleLogger;

  /**
   * Runs a command, mapping failures to typed errors and logging every attempt
   * for auditability.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<AuthResult<T>> {
    try {
      const value = await run();
      logger.info(`auth ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toAuthError(operation, error);
      logger.error(`auth ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  function publicUser(user: UserRecord): PublicUser {
    return { id: user.id, username: user.username };
  }

  async function issueSession(user: UserRecord): Promise<AuthSession> {
    const sessionId = randomUUID();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + tokens.sessionTtlMs);
    const sessionToken = await tokens.signSession({ userId: user.id, sessionId });

    store.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash: tokens.hash(sessionToken),
      expiresAt: expiresAt.toISOString(),
      createdAt: issuedAt.toISOString(),
    });

    return { sessionToken, expiresAt: expiresAt.toISOString(), user: publicUser(user) };
  }

  return {
    status: async () => ({ setupComplete: store.countVerifiedUsers() > 0 }),

    beginSetup: (input) =>
      guard('beginSetup', { username: input.username }, async () => {
        const username = input.username?.trim() ?? '';
        if (username.length === 0) {
          throw authError('invalid-input', 'A username is required');
        }
        if (store.countVerifiedUsers() > 0) {
          throw authError('setup-complete', 'Setup has already been completed');
        }

        const violations = policy.check(input.password ?? '', { username });
        if (violations.length > 0) {
          throw authError(
            'weak-password',
            violations.map((violation) => violation.message).join(' '),
          );
        }

        // A previous, unfinished attempt must not block this one.
        store.deleteUnverifiedUsers();

        const id = randomUUID();
        const secret = totp.generateSecret();
        const passwordHash = await hasher.hash(input.password);
        store.createUser({
          id,
          username,
          passwordHash,
          totpSecret: secret,
          totpVerified: false,
          createdAt: now().toISOString(),
        });

        return {
          setupToken: await tokens.signSetup({ userId: id }),
          otpauthUri: totp.keyUri({ secret, accountName: username }),
          secret,
        };
      }),

    verifySetup: (input) =>
      guard('verifySetup', {}, async () => {
        const claims = await tokens.verifySetup(input.setupToken ?? '');
        const user = claims === undefined ? undefined : store.getUser(claims.userId);
        if (user === undefined) {
          throw authError('invalid-session', 'Your setup session has expired; start again');
        }
        if (user.totpVerified) {
          throw authError('setup-complete', 'Setup has already been completed');
        }
        if (!totp.verify({ secret: user.totpSecret, token: input.token ?? '' })) {
          throw authError('invalid-totp', 'That code is not valid');
        }

        store.markTotpVerified(user.id);
        return issueSession({ ...user, totpVerified: true });
      }),

    login: (input) =>
      guard('login', { username: input.username }, async () => {
        const username = input.username?.trim() ?? '';
        if (username.length === 0 || (input.password ?? '').length === 0) {
          throw authError('invalid-input', 'Username and password are required');
        }
        if (store.countVerifiedUsers() === 0) {
          throw authError('setup-incomplete', 'Setup has not been completed yet');
        }

        const user = store.getUserByUsername(username);
        const matches = await hasher.verify(
          input.password,
          user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        );
        if (user === undefined || !matches) {
          throw authError('invalid-credentials', 'Incorrect username or password');
        }

        return { pendingToken: await tokens.signPending({ userId: user.id }) };
      }),

    verifyTwoFactor: (input) =>
      guard('verifyTwoFactor', {}, async () => {
        const claims = await tokens.verifyPending(input.pendingToken ?? '');
        const user = claims === undefined ? undefined : store.getUser(claims.userId);
        if (user === undefined || !user.totpVerified) {
          throw authError('invalid-session', 'Your login attempt has expired; start again');
        }
        if (!totp.verify({ secret: user.totpSecret, token: input.token ?? '' })) {
          throw authError('invalid-totp', 'That code is not valid');
        }

        return issueSession(user);
      }),

    authenticate: (sessionToken) =>
      guard('authenticate', {}, async () => {
        const claims = await tokens.verifySession(sessionToken ?? '');
        if (claims === undefined) {
          throw authError('invalid-session', 'You are not signed in');
        }

        const session = store.getSessionByTokenHash(tokens.hash(sessionToken));
        if (
          session === undefined ||
          session.id !== claims.sessionId ||
          session.userId !== claims.userId ||
          session.expiresAt <= now().toISOString()
        ) {
          throw authError('invalid-session', 'You are not signed in');
        }

        const user = store.getUser(claims.userId);
        if (user === undefined) {
          throw authError('invalid-session', 'You are not signed in');
        }
        return publicUser(user);
      }),

    logout: (sessionToken) =>
      guard('logout', {}, async () => {
        const claims = await tokens.verifySession(sessionToken ?? '');
        if (claims !== undefined) {
          store.deleteSession(claims.sessionId);
        }
      }),
  };
}
