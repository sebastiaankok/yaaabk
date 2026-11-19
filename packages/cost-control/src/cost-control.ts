import type { BudgetStore } from './budget-store';
import { DEFAULT_ISSUE_BUDGET_CENTS, KEY_TTL_MS, MAX_ISSUE_BUDGET_CENTS } from './config';
import {
  consoleLogger,
  costControlError,
  toCostControlError,
  type CostControlLogger,
} from './errors';
import { mintKey, revokeKey, usdFromCents } from './keys';
import type { OpenRouterApi, OpenRouterKey } from './openrouter-api';
import type { BudgetRecord, BudgetSummary, CostControlModule, CostControlResult } from './types';

export interface CostControlModuleOptions {
  /**
   * Low-level port the module is built on. Tests inject
   * {@link createFakeOpenRouterApi}; the backend injects the HTTP adapter.
   */
  api: OpenRouterApi;
  /** Where each Issue's key hash and budget are recorded. */
  store: BudgetStore;
  /** Defaults to {@link DEFAULT_ISSUE_BUDGET_CENTS}. */
  defaultBudgetCents?: number;
  /** Defaults to {@link MAX_ISSUE_BUDGET_CENTS}; a Developer cannot exceed it. */
  maxBudgetCents?: number;
  /** Defaults to {@link KEY_TTL_MS}. */
  keyTtlMs?: number;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  logger?: CostControlLogger;
}

/** Converts OpenRouter's USD float to whole cents, rounding to the nearest cent. */
export function centsFromUsd(usd: number): number {
  return Math.round(usd * 100);
}

/** Builds the public Cost Control Module. */
export function createCostControlModule(options: CostControlModuleOptions): CostControlModule {
  const { api, store } = options;
  const defaultBudgetCents = options.defaultBudgetCents ?? DEFAULT_ISSUE_BUDGET_CENTS;
  const maxBudgetCents = options.maxBudgetCents ?? MAX_ISSUE_BUDGET_CENTS;
  const keyTtlMs = options.keyTtlMs ?? KEY_TTL_MS;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? consoleLogger;

  /**
   * Runs a command, mapping failures to typed errors and logging every attempt
   * for auditability. The plaintext key is never part of the logged fields.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<CostControlResult<T>> {
    try {
      const value = await run();
      logger.info(`cost-control ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toCostControlError(operation, error);
      logger.error(`cost-control ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  /** Validates an explicit budget override against the system ceiling. */
  function budgetOrThrow(budgetCents: number): number {
    if (!Number.isInteger(budgetCents) || budgetCents < 1) {
      throw costControlError(
        'invalid-input',
        `A budget must be a whole number of cents (got ${budgetCents})`,
      );
    }
    if (budgetCents > maxBudgetCents) {
      throw costControlError(
        'budget-out-of-range',
        `A budget cannot exceed ${maxBudgetCents} cents (got ${budgetCents})`,
      );
    }
    return budgetCents;
  }

  return {
    open: (issueId, openOptions) => {
      const trimmed = issueId?.trim() ?? '';
      return guard('open', { issueId: trimmed }, async () => {
        if (trimmed === '') {
          throw costControlError('invalid-input', 'An issue id is required');
        }
        const budgetCents = budgetOrThrow(openOptions?.budgetCents ?? defaultBudgetCents);
        if (store.get(trimmed) !== undefined) {
          throw costControlError('already-open', `Issue ${trimmed} already has an OpenRouter key`);
        }

        const minted = await mintKey(api, {
          subject: `issue-${trimmed}`,
          budgetCents,
          ttlMs: keyTtlMs,
          maxBudgetCents,
          now,
        });

        const record: BudgetRecord = {
          issueId: trimmed,
          keyHash: minted.keyHash,
          budgetCents: minted.budgetCents,
          spentCents: 0,
          attempt: 1,
          expiresAt: minted.expiresAt,
          createdAt: minted.createdAt,
        };
        store.save(record);
        return { ...record, key: minted.key };
      });
    },
    topUp: (issueId, budgetCents) => {
      const trimmed = issueId?.trim() ?? '';
      return guard('topUp', { issueId: trimmed, budgetCents }, async () => {
        if (trimmed === '') {
          throw costControlError('invalid-input', 'An issue id is required');
        }
        const cents = budgetOrThrow(budgetCents);
        const record = store.get(trimmed);
        if (record === undefined) {
          throw costControlError('not-open', `Issue ${trimmed} has no OpenRouter key`);
        }
        if (cents <= record.spentCents) {
          throw costControlError(
            'budget-exhausted',
            `Issue ${trimmed} has already spent ${usdFromCents(record.spentCents).toFixed(2)} USD; a ${usdFromCents(cents).toFixed(2)} USD budget leaves nothing for the current key.`,
          );
        }

        const updated = await api.updateKey(record.keyHash, {
          // The key may only spend what the raised cap leaves after earlier
          // attempts; the total is not a fresh allowance for this key.
          limitUsd: usdFromCents(cents - record.spentCents),
        });
        const next: BudgetRecord = {
          ...record,
          budgetCents: cents,
          expiresAt: updated.expiresAt ?? record.expiresAt,
        };
        store.save(next);
        return next;
      });
    },
    summary: (issueId, requestedBudgetCents) => {
      const trimmed = issueId?.trim() ?? '';
      return guard(
        'summary',
        { issueId: trimmed, budgetCents: requestedBudgetCents },
        async (): Promise<BudgetSummary> => {
          if (trimmed === '') {
            throw costControlError('invalid-input', 'An issue id is required');
          }
          const budgetCents = budgetOrThrow(requestedBudgetCents);
          const record = store.get(trimmed);
          if (record === undefined) {
            return {
              issueId: trimmed,
              budgetCents,
              spentCents: 0,
              remainingCents: budgetCents,
              keyOpen: false,
              exhausted: false,
            };
          }

          const info = await api.getKey(record.keyHash);
          const spentCents = record.spentCents + centsFromUsd(info.usageUsd);
          const remainingCents = Math.max(0, budgetCents - spentCents);
          const expiresAt = info.expiresAt ?? record.expiresAt;
          const expired = expiresAt <= now().toISOString();
          return {
            issueId: trimmed,
            budgetCents,
            spentCents,
            remainingCents,
            keyOpen: true,
            exhausted: info.disabled || expired || remainingCents <= 0,
          };
        },
      );
    },
    status: (issueId) => {
      const trimmed = issueId?.trim() ?? '';
      return guard('status', { issueId: trimmed }, async () => {
        if (trimmed === '') {
          throw costControlError('invalid-input', 'An issue id is required');
        }
        const record = store.get(trimmed);
        if (record === undefined) {
          throw costControlError('not-open', `Issue ${trimmed} has no OpenRouter key`);
        }

        const info = await api.getKey(record.keyHash);
        const budgetCents = record.budgetCents;
        const usedCents = record.spentCents + centsFromUsd(info.usageUsd);
        const remainingCents = Math.max(0, budgetCents - usedCents);
        const expiresAt = info.expiresAt ?? record.expiresAt;
        const expired = expiresAt <= now().toISOString();

        return {
          issueId: trimmed,
          keyHash: record.keyHash,
          budgetCents,
          usedCents,
          remainingCents,
          expiresAt,
          disabled: info.disabled,
          exhausted: info.disabled || expired || remainingCents <= 0,
        };
      });
    },
    beginAttempt: (issueId, options) => {
      const trimmed = issueId?.trim() ?? '';
      return guard(
        'beginAttempt',
        { issueId: trimmed, attempt: options?.attempt, budgetCents: options?.budgetCents },
        async () => {
          if (trimmed === '') {
            throw costControlError('invalid-input', 'An issue id is required');
          }
          const budgetCents = budgetOrThrow(options?.budgetCents ?? defaultBudgetCents);
          const attempt = options?.attempt;
          if (!Number.isInteger(attempt) || attempt < 1) {
            throw costControlError(
              'invalid-input',
              `An attempt must be a positive whole number (got ${attempt})`,
            );
          }
          const record = store.get(trimmed);
          const priorKeyHash = record?.keyHash ?? options?.priorKeyHash?.trim() ?? '';
          if (record === undefined && attempt === 1 && priorKeyHash === '') {
            return {
              issueId: trimmed,
              remainingCents: budgetCents,
              spentCents: 0,
              priorKeyHash: null,
            };
          }

          if (priorKeyHash === '') {
            throw costControlError(
              'spend-unreadable',
              `Issue ${trimmed} already has attempts but no OpenRouter key to read their spend from, so the remaining budget is unknown. Refusing to start another attempt with a fresh full budget; reset the Issue's budget or contact an administrator.`,
            );
          }

          let info: OpenRouterKey;
          try {
            info = await api.getKey(priorKeyHash);
          } catch (error) {
            throw costControlError(
              'spend-unreadable',
              `Could not read the spend of OpenRouter key ${priorKeyHash} for Issue ${trimmed}, so the remaining budget is unknown. Refusing to start another attempt with a fresh full budget; check the OpenRouter management key and the Issue's key, then retry.`,
              error,
            );
          }

          const spentCents = (record?.spentCents ?? 0) + centsFromUsd(info.usageUsd);
          if (spentCents >= budgetCents) {
            throw costControlError(
              'budget-exhausted',
              `Issue ${trimmed} has spent ${usdFromCents(spentCents).toFixed(2)} USD of its ${usdFromCents(budgetCents).toFixed(2)} USD budget, leaving nothing for another attempt. Raise the Issue's budget to continue.`,
            );
          }

          return {
            issueId: trimmed,
            remainingCents: budgetCents - spentCents,
            spentCents,
            priorKeyHash,
          };
        },
      );
    },
    recordAttempt: (issueId, input) => {
      const trimmed = issueId?.trim() ?? '';
      return guard(
        'recordAttempt',
        { issueId: trimmed, attempt: input?.attempt, keyHash: input?.keyHash },
        async () => {
          if (trimmed === '') {
            throw costControlError('invalid-input', 'An issue id is required');
          }
          const budgetCents = budgetOrThrow(input?.budgetCents ?? defaultBudgetCents);
          if (!Number.isInteger(input?.attempt) || input.attempt < 1) {
            throw costControlError(
              'invalid-input',
              `An attempt must be a positive whole number (got ${input?.attempt})`,
            );
          }
          const keyHash = input?.keyHash?.trim() ?? '';
          if (keyHash === '') {
            throw costControlError('invalid-input', 'A key hash is required');
          }
          if (!Number.isInteger(input.spentCents) || input.spentCents < 0) {
            throw costControlError(
              'invalid-input',
              `Spent cents must be a whole, non-negative number (got ${input.spentCents})`,
            );
          }

          const record: BudgetRecord = {
            issueId: trimmed,
            keyHash,
            budgetCents,
            spentCents: input.spentCents,
            attempt: input.attempt,
            expiresAt: input.expiresAt,
            createdAt: input.createdAt,
          };
          store.save(record);
          return record;
        },
      );
    },
    release: (issueId) => {
      const trimmed = issueId?.trim() ?? '';
      return guard('release', { issueId: trimmed }, async () => {
        if (trimmed === '') {
          throw costControlError('invalid-input', 'An issue id is required');
        }
        const record = store.get(trimmed);
        if (record === undefined) {
          return;
        }

        // The key may already be gone, in which case only the local record is stale.
        await revokeKey(api, record.keyHash);
        store.delete(trimmed);
      });
    },
    mint: (input) => {
      const subject = input.subject?.trim() ?? '';
      return guard('mint', { subject }, () =>
        mintKey(api, {
          subject,
          budgetCents: input.budgetCents ?? defaultBudgetCents,
          ttlMs: input.ttlMs ?? keyTtlMs,
          maxBudgetCents,
          now,
        }),
      );
    },
    revoke: (hash) => {
      const trimmed = hash?.trim() ?? '';
      return guard('revoke', { keyHash: trimmed }, async () => {
        if (trimmed === '') {
          throw costControlError('invalid-input', 'A key hash is required');
        }
        await revokeKey(api, trimmed);
      });
    },
  };
}
