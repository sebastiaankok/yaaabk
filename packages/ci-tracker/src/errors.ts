import type { CiTrackerError, CiTrackerErrorKind } from './types';

/** Minimal logging seam so polling can be audited and captured in tests. */
export interface CiTrackerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: CiTrackerLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default in tests. */
export const silentLogger: CiTrackerLogger = {
  info: () => {},
  error: () => {},
};

const CI_KINDS: ReadonlySet<string> = new Set<CiTrackerErrorKind>(['invalid-input', 'unknown']);

/** Builds an error carrying a `kind`, so the backend can throw the same failure. */
export function taggedError<K extends string>(
  kind: K,
  message: string,
  cause?: unknown,
): Error & { kind: K } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { kind });
}

/** Builds a {@link CiTrackerError}-tagged error. */
export function ciError(
  kind: CiTrackerErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: CiTrackerErrorKind } {
  return taggedError(kind, message, cause);
}

/**
 * Maps anything thrown while polling into a typed {@link CiTrackerError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toCiError(operation: string, error: unknown): CiTrackerError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && CI_KINDS.has(kind)) {
      return { kind: kind as CiTrackerErrorKind, operation, message: messageOf(error) };
    }
  }
  return { kind: 'unknown', operation, message: messageOf(error) };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
