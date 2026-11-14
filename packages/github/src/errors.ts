import type { GitHubError, GitHubErrorKind } from './types';

/** Minimal logging seam so GitHub operations can be audited and captured in tests. */
export interface GitHubLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: GitHubLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default in tests. */
export const silentLogger: GitHubLogger = {
  info: () => {},
  error: () => {},
};

const GITHUB_KINDS: ReadonlySet<string> = new Set<GitHubErrorKind>([
  'invalid-input',
  'unauthorized',
  'forbidden',
  'not-found',
  'rate-limited',
  'conflict',
  'network',
  'unknown',
]);

/** Carries the extra HTTP fields a {@link GitHubError} may hold. */
export interface GitHubErrorDetails {
  statusCode?: number;
  resetAt?: string;
}

/** Builds an error carrying a `kind`, so a provider can throw the same typed failure. */
export function taggedError<K extends string>(
  kind: K,
  message: string,
  cause?: unknown,
): Error & { kind: K } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { kind });
}

/** Builds a {@link GitHubError}-tagged error. */
export function githubError(
  kind: GitHubErrorKind,
  message: string,
  details: GitHubErrorDetails = {},
  cause?: unknown,
): Error & { kind: GitHubErrorKind } & GitHubErrorDetails {
  return Object.assign(taggedError(kind, message, cause), details);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps anything thrown while talking to GitHub into a typed {@link GitHubError}.
 *
 * Errors already tagged with a known `kind` keep it; an HTTP status is used to
 * infer a kind when only the status is known; everything else is `unknown`.
 */
export function toGitHubError(operation: string, error: unknown): GitHubError {
  if (typeof error === 'object' && error !== null) {
    const { kind, statusCode, resetAt } = error as {
      kind?: unknown;
      statusCode?: unknown;
      resetAt?: unknown;
    };
    const details: GitHubErrorDetails = {};
    if (typeof statusCode === 'number') details.statusCode = statusCode;
    if (typeof resetAt === 'string') details.resetAt = resetAt;
    if (typeof kind === 'string' && GITHUB_KINDS.has(kind)) {
      return { kind: kind as GitHubErrorKind, operation, message: messageOf(error), ...details };
    }
    if (typeof statusCode === 'number') {
      return {
        kind: kindForStatus(statusCode),
        operation,
        message: messageOf(error),
        ...details,
      };
    }
  }
  return { kind: 'unknown', operation, message: messageOf(error) };
}

/** Maps an HTTP status to the closest {@link GitHubErrorKind}. */
export function kindForStatus(statusCode: number): GitHubErrorKind {
  if (statusCode === 401) return 'unauthorized';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 404) return 'not-found';
  if (statusCode === 409) return 'conflict';
  if (statusCode === 422) return 'invalid-input';
  return 'unknown';
}
