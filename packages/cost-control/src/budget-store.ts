/**
 * The persistence port the Cost Control Module is built on.
 *
 * One record per Issue tracks the key the latest attempt used, the Issue's
 * total cap and the spend every earlier attempt accumulated. Production uses
 * {@link createSqliteBudgetStore}; tests and local dev use
 * {@link createInMemoryBudgetStore}.
 *
 * Deliberately synchronous, matching the `bun:sqlite` adapter it grows into.
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
