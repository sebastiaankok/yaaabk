import { OpenRouterApiError } from './errors';
import type {
  CreateKeyInput,
  CreatedOpenRouterKey,
  OpenRouterApi,
  OpenRouterKey,
  UpdateKeyInput,
} from './openrouter-api';

/** OpenRouter's production API root. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterApiOptions {
  /** The Management API key; never sent to the agent or logged. */
  managementKey: string;
  /** Overrides {@link OPENROUTER_BASE_URL}, mainly for tests and proxies. */
  baseUrl?: string;
  /** Injected HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The subset of OpenRouter's key payload the module reads. */
interface KeyPayload {
  hash: string;
  name: string;
  disabled: boolean;
  limit: number | null;
  limit_remaining: number | null;
  usage: number;
  expires_at: string | null;
  created_at: string;
}

function toOpenRouterKey(data: KeyPayload): OpenRouterKey {
  return {
    hash: data.hash,
    name: data.name,
    disabled: data.disabled,
    limitUsd: data.limit,
    limitRemainingUsd: data.limit_remaining,
    usageUsd: data.usage,
    expiresAt: data.expires_at,
    createdAt: data.created_at,
  };
}

/**
 * Builds the HTTP adapter for OpenRouter's Management API.
 *
 * Every failure leaves as an {@link OpenRouterApiError}—carrying the response
 * status, or `network: true` when the request never landed—so the module can
 * classify it. The management key stays in the `Authorization` header and is
 * never echoed into an error message.
 */
export function createOpenRouterApi(options: OpenRouterApiOptions): OpenRouterApi {
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${options.managementKey}`,
    'Content-Type': 'application/json',
  };

  async function request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new OpenRouterApiError(error instanceof Error ? error.message : String(error), {
        network: true,
        cause: error,
      });
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        { error?: { message?: string } } | undefined;
      throw new OpenRouterApiError(
        body?.error?.message ?? `OpenRouter responded with ${response.status}`,
        { statusCode: response.status },
      );
    }

    if (response.status === 204) {
      return undefined;
    }
    return response.json();
  }

  return {
    async createKey(input: CreateKeyInput): Promise<CreatedOpenRouterKey> {
      const body = await request('/keys', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          limit: input.limitUsd,
          limit_reset: input.limitReset,
          expires_at: input.expiresAt,
        }),
      });
      const payload = body as { key: string; data: KeyPayload };
      return { key: payload.key, keyInfo: toOpenRouterKey(payload.data) };
    },

    async updateKey(hash: string, input: UpdateKeyInput): Promise<OpenRouterKey> {
      const payload = (await request(`/keys/${encodeURIComponent(hash)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(input.limitUsd === undefined ? {} : { limit: input.limitUsd }),
          ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
        }),
      })) as { data: KeyPayload };
      return toOpenRouterKey(payload.data);
    },

    async getKey(hash: string): Promise<OpenRouterKey> {
      const payload = (await request(`/keys/${encodeURIComponent(hash)}`, { method: 'GET' })) as {
        data: KeyPayload;
      };
      return toOpenRouterKey(payload.data);
    },

    async deleteKey(hash: string): Promise<void> {
      await request(`/keys/${encodeURIComponent(hash)}`, { method: 'DELETE' });
    },
  };
}
