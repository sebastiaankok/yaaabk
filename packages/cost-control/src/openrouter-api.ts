/**
 * The low-level port the Cost Control Module is built on: OpenRouter's
 * Management API key endpoints.
 *
 * The module works in cents; this port works in the API's own USD terms, so the
 * conversion lives in exactly one place. Implementations throw
 * {@link OpenRouterApiError} on failure; the module maps it to a typed
 * {@link CostControlError}.
 */

/** How a key's spending cap resets. `null` is a lifetime cap. */
export type LimitReset = 'daily' | 'weekly' | 'monthly' | null;

export interface CreateKeyInput {
  /** Human-readable name shown in the OpenRouter dashboard. */
  name: string;
  /** Spending cap in USD. */
  limitUsd: number;
  limitReset: LimitReset;
  /** ISO-8601 UTC expiry, or `null` for a key that never expires. */
  expiresAt: string | null;
}

export interface UpdateKeyInput {
  /** New spending cap in USD. */
  limitUsd?: number;
  /** Disable or re-enable the key. */
  disabled?: boolean;
}

/** A key as OpenRouter reports it. Never carries the plaintext key. */
export interface OpenRouterKey {
  hash: string;
  name: string;
  disabled: boolean;
  /** Spending cap in USD, or `null` when unlimited. */
  limitUsd: number | null;
  /** Cap minus usage in USD, or `null` when unlimited. */
  limitRemainingUsd: number | null;
  usageUsd: number;
  expiresAt: string | null;
  createdAt: string;
}

/** A key's metadata plus the plaintext key, which only creation returns. */
export interface CreatedOpenRouterKey {
  /** The `sk-or-...` key the agent authenticates with. Shown once. */
  key: string;
  keyInfo: OpenRouterKey;
}

export interface OpenRouterApi {
  createKey(input: CreateKeyInput): Promise<CreatedOpenRouterKey>;
  updateKey(hash: string, input: UpdateKeyInput): Promise<OpenRouterKey>;
  getKey(hash: string): Promise<OpenRouterKey>;
  deleteKey(hash: string): Promise<void>;
}
