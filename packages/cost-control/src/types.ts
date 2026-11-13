/**
 * Public domain types for the Cost Control Module.
 *
 * Each Issue gets one OpenRouter sub-key with a lifetime spending cap, created
 * through the Management API. The module owns that key's lifecycle: create it
 * when an Issue is picked up, watch its remaining budget while the agent runs,
 * top it up when a Developer raises the cap, and delete it when the Issue is
 * done.
 *
 * Money is stored in cents everywhere so budgets are exact integers and match
 * the `budget_cents` column on the Issue. OpenRouter speaks USD floats; the
 * conversion happens only at the API boundary.
 *
 * Timestamps are ISO-8601 UTC strings, matching the rest of YAAABK.
 */

/** The kinds of failure a Cost Control command can report. */
export type CostControlErrorKind =
  | 'invalid-input'
  | 'budget-out-of-range'
  | 'already-open'
  | 'not-open'
  | 'unauthorized'
  | 'not-found'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface CostControlError {
  kind: CostControlErrorKind;
  /** The operation that failed, e.g. `open`. */
  operation: string;
  message: string;
  /** HTTP status from OpenRouter, when the failure came from a response. */
  statusCode?: number;
}

/** The result of a Cost Control command: either a value or a typed error. */
export type CostControlResult<T> = { ok: true; value: T } | { ok: false; error: CostControlError };

/** An Issue's budget as persisted. */
export interface BudgetRecord {
  issueId: string;
  /** OpenRouter key hash, the handle every later API call uses. */
  keyHash: string;
  /** Spending cap in cents. */
  budgetCents: number;
  expiresAt: string;
  createdAt: string;
}

/** A freshly created budget, returned with the key the agent authenticates with. */
export interface IssuedBudget extends BudgetRecord {
  /**
   * The plaintext OpenRouter key. OpenRouter returns it only at creation, so
   * this is the one moment it exists outside the agent's environment.
   */
  key: string;
}

/** How much of an Issue's budget is left. */
export interface BudgetStatus {
  issueId: string;
  keyHash: string;
  /** Spending cap in cents. */
  budgetCents: number;
  /** Spent so far, in cents, rounded to the nearest cent. */
  usedCents: number;
  /** `budgetCents - usedCents`; never negative. */
  remainingCents: number;
  expiresAt: string;
  /** True once an operator disabled the key at OpenRouter. */
  disabled: boolean;
  /**
   * Whether the agent must pause: nothing left, key disabled, or key expired.
   * The caller pauses the Job; it is never killed, so a top-up resumes it.
   */
  exhausted: boolean;
}

/**
 * The Cost Control Module's public contract.
 *
 * Every command resolves to a {@link CostControlResult}; callers branch on `ok`
 * instead of catching exceptions, matching the other YAAABK modules. All
 * commands are keyed by Issue, so callers never handle key hashes themselves.
 */
export interface CostControlModule {
  /** Creates the Issue's key with a lifetime cap, or fails if it already has one. */
  open(
    issueId: string,
    options?: { budgetCents?: number },
  ): Promise<CostControlResult<IssuedBudget>>;
  /** Raises or lowers the Issue's cap and records the new budget. */
  topUp(issueId: string, budgetCents: number): Promise<CostControlResult<BudgetRecord>>;
  /** Reports the Issue's remaining budget and whether the agent must pause. */
  status(issueId: string): Promise<CostControlResult<BudgetStatus>>;
  /** Deletes the Issue's key and forgets its budget. A no-op when not open. */
  release(issueId: string): Promise<CostControlResult<void>>;
}
