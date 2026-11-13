import type { CostControlError, CostControlErrorKind } from './types';

/** Minimal logging seam so the module's audit logging can be captured in tests. */
export interface CostControlLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: CostControlLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything. */
export const silentLogger: CostControlLogger = {
  info: () => {},
  error: () => {},
};

/**
 * What a low-level OpenRouter API adapter throws. The module maps it to a
 * typed {@link CostControlError}, so a transport failure never surprises a
 * caller with an exception.
 */
export class OpenRouterApiError extends Error {
  /** HTTP status, when the failure came from a response. */
  readonly statusCode: number | undefined;
  /** True when the request never reached OpenRouter. */
  readonly network: boolean;

  constructor(
    message: string,
    options: { statusCode?: number; network?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenRouterApiError';
    this.statusCode = options.statusCode;
    this.network = options.network ?? false;
  }
}

const KINDS: ReadonlySet<string> = new Set<CostControlErrorKind>([
  'invalid-input',
  'budget-out-of-range',
  'already-open',
  'not-open',
  'unauthorized',
  'not-found',
  'rate-limited',
  'server',
  'network',
  'unknown',
]);

/**
 * Builds an error carrying a {@link CostControlErrorKind}, so the module can
 * throw the same typed failure it reports to callers.
 */
export function costControlError(
  kind: CostControlErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: CostControlErrorKind } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { kind });
}

/** Collapses an HTTP status into the kind the module reports. */
function kindForStatus(statusCode: number): CostControlErrorKind {
  if (statusCode === 401 || statusCode === 403) {
    return 'unauthorized';
  }
  if (statusCode === 404) {
    return 'not-found';
  }
  if (statusCode === 429) {
    return 'rate-limited';
  }
  if (statusCode === 400 || statusCode === 422) {
    return 'invalid-input';
  }
  if (statusCode >= 500) {
    return 'server';
  }
  return 'unknown';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps anything thrown by an API adapter into a typed {@link CostControlError}.
 *
 * Errors already tagged with a known `kind` keep it; {@link OpenRouterApiError}
 * is classified by its status code; everything else is `unknown`.
 */
export function toCostControlError(operation: string, error: unknown): CostControlError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && KINDS.has(kind)) {
      return { kind: kind as CostControlErrorKind, operation, message: messageOf(error) };
    }
    if (error instanceof OpenRouterApiError) {
      const kindFromStatus =
        error.statusCode === undefined
          ? error.network
            ? 'network'
            : 'unknown'
          : kindForStatus(error.statusCode);
      return {
        kind: kindFromStatus,
        operation,
        message: messageOf(error),
        ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
      };
    }
  }
  return { kind: 'unknown', operation, message: messageOf(error) };
}
