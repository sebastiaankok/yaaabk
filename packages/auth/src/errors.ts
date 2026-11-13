import type { AuthError, AuthErrorKind } from './types';

/** Minimal logging seam so audit logging can be captured in tests. */
export interface AuthLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: AuthLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default for fakes. */
export const silentLogger: AuthLogger = {
  info: () => {},
  error: () => {},
};

const KINDS: ReadonlySet<string> = new Set<AuthErrorKind>([
  'invalid-input',
  'weak-password',
  'setup-complete',
  'setup-incomplete',
  'invalid-credentials',
  'invalid-totp',
  'invalid-session',
  'unknown',
]);

/**
 * Builds an error carrying an {@link AuthErrorKind}, so internal helpers can
 * throw the same typed failure the module reports to callers.
 */
export function authError(kind: AuthErrorKind, message: string): Error & { kind: AuthErrorKind } {
  return Object.assign(new Error(message), { kind });
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Maps anything thrown inside the module into a typed {@link AuthError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown` and the message is not surfaced to callers.
 */
export function toAuthError(operation: string, error: unknown): AuthError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && KINDS.has(kind)) {
      return { kind: kind as AuthErrorKind, operation, message: messageOf(error) };
    }
  }
  return { kind: 'unknown', operation, message: 'Something went wrong' };
}
