import type { K8sError, K8sErrorKind } from './types';

/** Minimal logging seam so dry-run and audit logging can be captured in tests. */
export interface K8sLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: K8sLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default for the mock client. */
export const silentLogger: K8sLogger = {
  info: () => {},
  error: () => {},
};

/**
 * Builds an error shaped like `@kubernetes/client-node`'s `ApiException`, so
 * fakes can trigger the same typed-error mapping as a real API server.
 */
export function apiError(statusCode: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code: statusCode });
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

function statusKind(status: number): K8sErrorKind | undefined {
  switch (status) {
    case 400:
    case 422:
      return 'invalid';
    case 401:
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    default:
      return undefined;
  }
}

function networkCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code, cause } = error as HttpLikeError;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return code;
  }
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as HttpLikeError).code;
    if (typeof causeCode === 'string' && NETWORK_CODES.has(causeCode)) {
      return causeCode;
    }
  }
  return undefined;
}

/**
 * Maps anything thrown by the adapter into a typed {@link K8sError}.
 *
 * Recognises the HTTP status codes surfaced by `@kubernetes/client-node`
 * (`code` on `ApiException`) and the common socket error codes.
 */
export function toK8sError(operation: string, error: unknown): K8sError {
  if (typeof error === 'object' && error !== null) {
    const { code, statusCode } = error as HttpLikeError;
    const status =
      typeof code === 'number' ? code : typeof statusCode === 'number' ? statusCode : undefined;
    if (status !== undefined) {
      const kind = statusKind(status) ?? 'unknown';
      return { kind, operation, message: messageOf(error), statusCode: status };
    }
    const code2 = networkCode(error);
    if (code2 !== undefined) {
      return { kind: 'network', operation, message: messageOf(error) };
    }
  }
  return { kind: 'unknown', operation, message: messageOf(error) };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
