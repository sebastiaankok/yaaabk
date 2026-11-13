import type { BudgetStore } from './budget-store';
import { DEFAULT_ISSUE_BUDGET_CENTS, KEY_TTL_MS, MAX_ISSUE_BUDGET_CENTS } from './config';
import {
  consoleLogger,
  costControlError,
  OpenRouterApiError,
  toCostControlError,
  type CostControlLogger,
} from './errors';
import type { OpenRouterApi } from './openrouter-api';
import type { BudgetRecord, CostControlModule, CostControlResult } from './types';

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

/** Converts a cents budget to the USD float OpenRouter expects. */
export function usdFromCents(cents: number): number {
  return cents / 100;
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

        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + keyTtlMs).toISOString();
        const created = await api.createKey({
          name: `yaaabk-issue-${trimmed}`,
          limitUsd: usdFromCents(budgetCents),
          limitReset: null,
          expiresAt,
        });

        const record: BudgetRecord = {
          issueId: trimmed,
          keyHash: created.keyInfo.hash,
          budgetCents,
          expiresAt,
          createdAt: createdAt.toISOString(),
        };
        store.save(record);
        return { ...record, key: created.key };
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

        const updated = await api.updateKey(record.keyHash, { limitUsd: usdFromCents(cents) });
        const next: BudgetRecord = {
          ...record,
          budgetCents: cents,
          expiresAt: updated.expiresAt ?? record.expiresAt,
        };
        store.save(next);
        return next;
      });
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
        const budgetCents =
          info.limitUsd === null ? record.budgetCents : centsFromUsd(info.limitUsd);
        const usedCents = centsFromUsd(info.usageUsd);
        const remainingUsd =
          info.limitRemainingUsd === null ? info.limitUsd : info.limitRemainingUsd;
        const remainingCents =
          remainingUsd === null
            ? Math.max(0, budgetCents - usedCents)
            : Math.max(0, centsFromUsd(remainingUsd));
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

        try {
          await api.deleteKey(record.keyHash);
        } catch (error) {
          // The key is already gone, so only the local record is stale.
          const alreadyDeleted = error instanceof OpenRouterApiError && error.statusCode === 404;
          if (!alreadyDeleted) {
            throw error;
          }
        }
        store.delete(trimmed);
      });
    },
  };
}
