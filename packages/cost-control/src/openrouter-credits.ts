import { toCostControlError } from './errors';
import type { OpenRouterCredits } from './openrouter-api';
import { createOpenRouterApi, type OpenRouterApiOptions } from './openrouter-http';

/** The failure kinds a balance lookup can report. */
export type OpenRouterCreditsFailureKind = 'unauthorized' | 'network' | 'server' | 'rate-limited';

/** Either the account balance or the reason it could not be read. */
export type OpenRouterCreditsResult =
  | { ok: true; value: OpenRouterCredits }
  | { ok: false; kind: OpenRouterCreditsFailureKind; message: string };

/** Reads the account-wide balance with a management key. */
export interface OpenRouterCreditsReader {
  read(managementKey: string): Promise<OpenRouterCreditsResult>;
}

const FAILURE_KINDS: ReadonlySet<string> = new Set<OpenRouterCreditsFailureKind>([
  'unauthorized',
  'network',
  'server',
  'rate-limited',
]);

/**
 * Builds a balance reader over OpenRouter's Management API.
 *
 * Every failure is mapped into the kinds Settings can present; anything that is
 * not an authentication, transport or rate-limit problem is a bad gateway. The
 * management key stays in the `Authorization` header and is never echoed.
 */
export function createOpenRouterCreditsReader(
  options: Omit<OpenRouterApiOptions, 'managementKey'> = {},
): OpenRouterCreditsReader {
  return {
    async read(managementKey) {
      try {
        const value = await createOpenRouterApi({ ...options, managementKey }).getCredits();
        return { ok: true, value };
      } catch (error) {
        const mapped = toCostControlError('read-credits', error);
        return {
          ok: false,
          kind: FAILURE_KINDS.has(mapped.kind)
            ? (mapped.kind as OpenRouterCreditsFailureKind)
            : 'server',
          message: mapped.message,
        };
      }
    },
  };
}
