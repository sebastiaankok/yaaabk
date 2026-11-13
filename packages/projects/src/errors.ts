import type { RepositoryError, RepositoryErrorKind } from './repository';
import type { ProjectError, ProjectErrorKind } from './types';

/** Minimal logging seam so provisioning can be audited and captured in tests. */
export interface ProjectsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: ProjectsLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default in tests. */
export const silentLogger: ProjectsLogger = {
  info: () => {},
  error: () => {},
};

const PROJECT_KINDS: ReadonlySet<string> = new Set<ProjectErrorKind>([
  'invalid-input',
  'duplicate-name',
  'not-found',
  'repository',
  'scaffold',
  'kubernetes',
  'unknown',
]);

const REPOSITORY_KINDS: ReadonlySet<string> = new Set<RepositoryErrorKind>([
  'invalid-input',
  'already-exists',
  'unauthorized',
  'not-found',
  'network',
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

/** Builds a {@link ProjectError}-tagged error. */
export function projectError(
  kind: ProjectErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: ProjectErrorKind } {
  return taggedError(kind, message, cause);
}

/**
 * Maps anything thrown while provisioning into a typed {@link ProjectError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toProjectError(operation: string, error: unknown): ProjectError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && PROJECT_KINDS.has(kind)) {
      return { kind: kind as ProjectErrorKind, operation, message: messageOf(error) };
    }
  }
  return { kind: 'unknown', operation, message: messageOf(error) };
}

interface HttpLikeError {
  code?: unknown;
  statusCode?: unknown;
  cause?: unknown;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function statusKind(status: number, message: string): RepositoryErrorKind {
  switch (status) {
    case 401:
    case 403:
      return 'unauthorized';
    case 404:
      return 'not-found';
    case 422:
      return message.toLowerCase().includes('already exists') ? 'already-exists' : 'invalid-input';
    default:
      return 'unknown';
  }
}

function networkCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, cause } = error as HttpLikeError;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return true;
  }
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as HttpLikeError).code;
    if (typeof causeCode === 'string' && NETWORK_CODES.has(causeCode)) {
      return true;
    }
  }
  return false;
}

/**
 * Maps anything thrown by a repository adapter into a typed {@link RepositoryError}.
 *
 * Recognises the HTTP status codes a provider surfaces (`statusCode` on a
 * thrown error) and the common socket error codes.
 */
export function toRepositoryError(operation: string, error: unknown): RepositoryError {
  const message = messageOf(error);
  if (typeof error === 'object' && error !== null) {
    const { kind, statusCode } = error as { kind?: unknown; statusCode?: unknown };
    if (typeof kind === 'string' && REPOSITORY_KINDS.has(kind)) {
      return { kind: kind as RepositoryErrorKind, operation, message };
    }
    if (typeof statusCode === 'number') {
      return {
        kind: statusKind(statusCode, message),
        operation,
        message,
        statusCode,
      };
    }
    if (networkCode(error)) {
      return { kind: 'network', operation, message };
    }
  }
  return { kind: 'unknown', operation, message };
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
