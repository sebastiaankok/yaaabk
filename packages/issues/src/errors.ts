import type { IssueError, IssueErrorKind } from './types';

/** Minimal logging seam so issue operations can be audited and captured in tests. */
export interface IssuesLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: IssuesLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default in tests. */
export const silentLogger: IssuesLogger = {
  info: () => {},
  error: () => {},
};

const ISSUE_KINDS: ReadonlySet<string> = new Set<IssueErrorKind>([
  'invalid-input',
  'duplicate-title',
  'not-found',
  'cycle',
  'unknown',
]);

/** Builds an error carrying a `kind`, so a backend can throw the same typed failure. */
export function taggedError<K extends string>(
  kind: K,
  message: string,
  cause?: unknown,
): Error & { kind: K } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { kind });
}

/** Builds an {@link IssueError}-tagged error. */
export function issuesError(
  kind: IssueErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: IssueErrorKind } {
  return taggedError(kind, message, cause);
}

/**
 * Maps anything thrown while handling an issue into a typed {@link IssueError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toIssuesError(operation: string, error: unknown): IssueError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && ISSUE_KINDS.has(kind)) {
      return { kind: kind as IssueErrorKind, operation, message: messageOf(error) };
    }
  }
  return { kind: 'unknown', operation, message: messageOf(error) };
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
