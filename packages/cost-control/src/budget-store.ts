/**
 * The persistence port the Cost Control Module is built on.
 *
 * The Issue is the natural home for `openrouter_key_hash` and `budget_cents`,
 * but the Issues Module does not exist yet. This port is that seam: tests and
 * the current backend use {@link createInMemoryBudgetStore}, and the Issues
 * Module implements it once Issues are persisted.
 *
 * Deliberately synchronous, matching the `bun:sqlite` adapter it will grow into.
 */

import type { BudgetRecord } from './types';

export interface BudgetStore {
  /** Inserts or replaces the budget for the record's Issue. */
  save(record: BudgetRecord): void;
  get(issueId: string): BudgetRecord | undefined;
  delete(issueId: string): void;
}

/** Builds a budget store that keeps records in a Map, for tests and local dev. */
export function createInMemoryBudgetStore(): BudgetStore {
  const records = new Map<string, BudgetRecord>();

  return {
    save(record) {
      records.set(record.issueId, { ...record });
    },
    get(issueId) {
      const record = records.get(issueId);
      return record === undefined ? undefined : { ...record };
    },
    delete(issueId) {
      records.delete(issueId);
    },
  };
}
