import { KEY_TTL_MS, MAX_ISSUE_BUDGET_CENTS } from './config';
import { OpenRouterApiError, costControlError } from './errors';
import type { OpenRouterApi } from './openrouter-api';
import type { MintedKey } from './types';

export interface MintKeyOptions {
  /** Stable subject, e.g. `session-s1`; becomes part of the key name. */
  subject: string;
  /** Spending cap in cents. */
  budgetCents: number;
  /** Lifetime in milliseconds. Defaults to {@link KEY_TTL_MS}. */
  ttlMs?: number;
  /** Defaults to {@link MAX_ISSUE_BUDGET_CENTS}; the caller cannot exceed it. */
  maxBudgetCents?: number;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Converts a cents budget to the USD float OpenRouter expects. */
export function usdFromCents(cents: number): number {
  return cents / 100;
}

/**
 * Mints one budgeted, expiring key at OpenRouter without persisting a budget.
 *
 * The caller owns the returned hash and must revoke it; this is the seam a
 * Grill-Me Session uses for its own key instead of the Issue budget store.
 */
export async function mintKey(api: OpenRouterApi, options: MintKeyOptions): Promise<MintedKey> {
  const subject = options.subject.trim();
  if (subject === '') {
    throw costControlError('invalid-input', 'A key subject is required');
  }

  const maxBudgetCents = options.maxBudgetCents ?? MAX_ISSUE_BUDGET_CENTS;
  if (!Number.isInteger(options.budgetCents) || options.budgetCents < 1) {
    throw costControlError(
      'invalid-input',
      `A budget must be a whole number of cents (got ${options.budgetCents})`,
    );
  }
  if (options.budgetCents > maxBudgetCents) {
    throw costControlError(
      'budget-out-of-range',
      `A budget cannot exceed ${maxBudgetCents} cents (got ${options.budgetCents})`,
    );
  }

  const ttlMs = options.ttlMs ?? KEY_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw costControlError('invalid-input', `A key lifetime must be positive (got ${ttlMs})`);
  }

  const createdAt = (options.now ?? (() => new Date()))();
  const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
  const created = await api.createKey({
    name: `yaaabk-${subject}`,
    limitUsd: usdFromCents(options.budgetCents),
    limitReset: null,
    expiresAt,
  });

  return {
    subject,
    keyHash: created.keyInfo.hash,
    key: created.key,
    budgetCents: options.budgetCents,
    expiresAt,
    createdAt: createdAt.toISOString(),
  };
}

/** Deletes a key by hash, treating an already-deleted key as success. */
export async function revokeKey(api: OpenRouterApi, hash: string): Promise<void> {
  try {
    await api.deleteKey(hash);
  } catch (error) {
    const alreadyDeleted = error instanceof OpenRouterApiError && error.statusCode === 404;
    if (!alreadyDeleted) throw error;
  }
}
