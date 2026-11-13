import type { PlanError, PlanErrorKind } from './types';

/** Minimal logging seam so plan operations can be audited and captured in tests. */
export interface PlansLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: PlansLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default in tests. */
export const silentLogger: PlansLogger = {
  info: () => {},
  error: () => {},
};

const PLAN_KINDS: ReadonlySet<string> = new Set<PlanErrorKind>([
  'invalid-input',
  'not-found',
  'duplicate-version',
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

/** Builds a {@link PlanError}-tagged error. */
export function plansError(
  kind: PlanErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: PlanErrorKind } {
  return taggedError(kind, message, cause);
}

/**
 * Maps anything thrown while handling a plan into a typed {@link PlanError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toPlansError(operation: string, error: unknown): PlanError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && PLAN_KINDS.has(kind)) {
      return { kind: kind as PlanErrorKind, operation, message: messageOf(error) };
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
