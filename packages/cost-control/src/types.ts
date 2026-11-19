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
  | 'budget-exhausted'
  | 'spend-unreadable'
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
  /** The Issue's total spending cap in cents. */
  budgetCents: number;
  /** Cumulative cents spent by earlier attempts, before this key. */
  spentCents: number;
  /** 1-based attempt this key was minted for. */
  attempt: number;
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

/** What minting a key for a generic subject needs. */
export interface MintKeyInput {
  /** Stable subject, e.g. `session-s1`; becomes part of the key name. */
  subject: string;
  /** Spending cap in cents. Defaults to the module's default budget. */
  budgetCents?: number;
  /** Lifetime in milliseconds. Defaults to the module's key lifetime. */
  ttlMs?: number;
}

/** A freshly minted key that is not tied to a persisted budget. */
export interface MintedKey {
  subject: string;
  /** OpenRouter key hash, the handle later API calls use. */
  keyHash: string;
  /** The plaintext key, returned once at creation. */
  key: string;
  /** Spending cap in cents. */
  budgetCents: number;
  expiresAt: string;
  createdAt: string;
}

/** What one attempt may still spend before it starts. */
export interface AttemptBudget {
  issueId: string;
  /** Cents the next key may be capped at, after every earlier attempt's spend. */
  remainingCents: number;
  /** Cumulative cents already spent on the Issue before this attempt. */
  spentCents: number;
  /** The previous attempt's key whose usage was counted, when there was one. */
  priorKeyHash: string | null;
}

/** What a caller records after minting an attempt's key. */
export interface RecordAttemptInput {
  /** The Issue's total cap in cents. */
  budgetCents: number;
  /** 1-based sequence of the attempt the key was minted for. */
  attempt: number;
  /** Hash of the freshly minted key. */
  keyHash: string;
  /** Cumulative cents spent before this attempt. */
  spentCents: number;
  expiresAt: string;
  createdAt: string;
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
  /**
   * Reports what a new attempt may spend after every earlier attempt on the
   * Issue. The first attempt gets the whole budget; a later one reads the
   * previous key's usage from OpenRouter, so the cap is cumulative rather than
   * reset per attempt. Fails with `spend-unreadable` when that usage cannot be
   * read, rather than granting a fresh full budget.
   */
  beginAttempt(
    issueId: string,
    options: { budgetCents: number; attempt: number; priorKeyHash?: string | null },
  ): Promise<CostControlResult<AttemptBudget>>;
  /** Records the key a new attempt was minted, with the spend it must build on. */
  recordAttempt(
    issueId: string,
    input: RecordAttemptInput,
  ): Promise<CostControlResult<BudgetRecord>>;
  /** Deletes the Issue's key and forgets its budget. A no-op when not open. */
  release(issueId: string): Promise<CostControlResult<void>>;
  /**
   * Creates a budgeted, expiring key for a generic subject, such as a
   * Grill-Me Session. It records no budget; the caller owns the key hash.
   */
  mint(input: MintKeyInput): Promise<CostControlResult<MintedKey>>;
  /** Deletes any key by hash. A key already gone at OpenRouter is a no-op. */
  revoke(hash: string): Promise<CostControlResult<void>>;
}
