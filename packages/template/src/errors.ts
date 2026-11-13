import type { TemplateError, TemplateErrorKind } from './types';

/** Minimal logging seam so dry-run and audit logging can be captured in tests. */
export interface TemplateLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: TemplateLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default for the fake backend. */
export const silentLogger: TemplateLogger = {
  info: () => {},
  error: () => {},
};

const KINDS: ReadonlySet<string> = new Set<TemplateErrorKind>([
  'invalid-project',
  'missing-template',
  'push-failed',
  'unknown',
]);

/**
 * Builds an error carrying a {@link TemplateErrorKind}, so a backend can throw
 * the same typed failure the module reports to callers.
 */
export function templateError(
  kind: TemplateErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: TemplateErrorKind } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { kind });
}

/**
 * Maps anything thrown by a backend into a typed {@link TemplateError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toTemplateError(operation: string, error: unknown): TemplateError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && KINDS.has(kind)) {
      return { kind: kind as TemplateErrorKind, operation, message: messageOf(error) };
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
