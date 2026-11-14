import type { OpenRouterVerifyFailure, OpenRouterVerifyResult } from './openrouter-verify-types';

/** OpenRouter's production API root; shared with the key-management adapter. */
import { OPENROUTER_BASE_URL } from './openrouter-http';

export interface OpenRouterVerifierOptions {
  /** Overrides {@link OPENROUTER_BASE_URL}, mainly for tests and proxies. */
  baseUrl?: string;
  /** Injected HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface ListKeysPayload {
  data?: Array<{ workspace_id?: string }>;
}

/**
 * Builds a verifier for OpenRouter management keys using the cheapest read —
 * `GET /keys` — so a Settings verify costs nothing against the daily
 * key-management quota.
 *
 * The result matches the Settings Module's {@link OpenRouterVerifier} port
 * structurally; the backend wires it in without a package dependency cycle.
 */
export function createOpenRouterVerifier(options: OpenRouterVerifierOptions = {}): {
  verify(managementKey: string): Promise<OpenRouterVerifyResult>;
} {
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async verify(managementKey) {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/keys`, {
          headers: { Authorization: `Bearer ${managementKey}` },
        });
      } catch (error) {
        return {
          ok: false,
          kind: 'network',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (response.status === 401 || response.status === 403) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        return {
          ok: false,
          kind: 'unauthorized',
          message: body?.error?.message ?? 'OpenRouter rejected the management key',
        };
      }
      if (response.status === 429) {
        return { ok: false, kind: 'rate-limited', message: 'OpenRouter rate limit exceeded' };
      }
      if (!response.ok) {
        return {
          ok: false,
          kind: 'server',
          message: `OpenRouter responded with ${response.status}`,
        };
      }

      const payload = (await response.json()) as ListKeysPayload;
      const keys = payload.data ?? [];
      const workspaceId = keys.find((key) => key.workspace_id !== undefined)?.workspace_id;
      return {
        ok: true,
        value: {
          keys: keys.length,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        },
      };
    },
  };
}

export type { OpenRouterVerifyFailure, OpenRouterVerifyResult };
