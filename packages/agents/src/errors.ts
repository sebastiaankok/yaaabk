import type { AgentError, AgentErrorKind } from './types';

/** Minimal logging seam so scheduling can be audited and captured in tests. */
export interface AgentsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: AgentsLogger = {
  info: (message, fields) => console.info(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

/** A logger that discards everything; the default in tests. */
export const silentLogger: AgentsLogger = {
  info: () => {},
  error: () => {},
};

const AGENT_KINDS: ReadonlySet<string> = new Set<AgentErrorKind>([
  'invalid-input',
  'not-found',
  'issue-not-synced',
  'kubernetes',
  'unauthorized',
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

/** Builds an {@link AgentError}-tagged error. */
export function agentsError(
  kind: AgentErrorKind,
  message: string,
  cause?: unknown,
): Error & { kind: AgentErrorKind } {
  return taggedError(kind, message, cause);
}

/**
 * Maps anything thrown while scheduling into a typed {@link AgentError}.
 *
 * Errors already tagged with a known `kind` keep it; everything else is
 * reported as `unknown`.
 */
export function toAgentsError(operation: string, error: unknown): AgentError {
  if (typeof error === 'object' && error !== null) {
    const { kind } = error as { kind?: unknown };
    if (typeof kind === 'string' && AGENT_KINDS.has(kind)) {
      return { kind: kind as AgentErrorKind, operation, message: messageOf(error) };
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
