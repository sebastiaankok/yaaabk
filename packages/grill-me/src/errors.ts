import type { GrillMeError, GrillMeErrorKind } from './types';

/** Minimal logging seam so session lifecycle and dry-run intent can be captured. */
export interface GrillMeLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: GrillMeLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default for the fake spawner. */
export const silentLogger: GrillMeLogger = {
  info: () => {},
  error: () => {},
};

const KINDS: ReadonlySet<string> = new Set<GrillMeErrorKind>([
  'invalid-input',
  'unknown-session',
  'spawn-failed',
  'write-failed',
  'timeout',
  'invalid-issues',
  'process-failed',
  'unknown',
]);

/**
 * Builds an error carrying a {@link GrillMeErrorKind}, so any layer can throw
 * the same typed failure the module reports to callers.
 */
export function grillMeError(
  kind: GrillMeErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: GrillMeErrorKind } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { kind });
}

/**
 * Maps anything thrown inside the module into a typed {@link GrillMeError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toGrillMeError(operation: string, error: unknown): GrillMeError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && KINDS.has(kind)) {
      return { kind: kind as GrillMeErrorKind, operation, message: messageOf(error) };
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
