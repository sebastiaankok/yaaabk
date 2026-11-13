/** Default per-Issue spending cap in cents ($0.50). */
export const DEFAULT_ISSUE_BUDGET_CENTS = 50;

/** Hard system ceiling per Issue in cents ($5.00); a Developer cannot exceed it. */
export const MAX_ISSUE_BUDGET_CENTS = 500;

/** How long a per-Issue key lives before OpenRouter expires it. */
export const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Environment variable holding the Developer's OpenRouter Management API key. */
export const MANAGEMENT_KEY_ENV = 'OPENROUTER_MANAGEMENT_KEY';

/** Environment variable overriding the default per-Issue budget, in cents. */
export const DEFAULT_BUDGET_ENV = 'YAAABK_DEFAULT_ISSUE_BUDGET_CENTS';

export interface CostControlConfig {
  /**
   * Management key used to provision sub-keys. `undefined` when the Developer
   * has not configured OpenRouter yet, which the module reports as
   * `invalid-input` rather than reaching the API.
   */
  managementKey: string | undefined;
  /** Default per-Issue cap in cents, clamped to {@link MAX_ISSUE_BUDGET_CENTS}. */
  defaultBudgetCents: number;
}

/**
 * Reads the module's configuration from the environment.
 *
 * A malformed default budget is a deployment mistake, so it fails loudly at
 * start rather than silently spending an unexpected amount.
 */
export function loadCostControlConfig(
  env: Record<string, string | undefined> = process.env,
): CostControlConfig {
  const rawBudget = env[DEFAULT_BUDGET_ENV];
  let defaultBudgetCents = DEFAULT_ISSUE_BUDGET_CENTS;
  if (rawBudget !== undefined && rawBudget.trim() !== '') {
    const parsed = Number(rawBudget);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${DEFAULT_BUDGET_ENV} must be a positive integer number of cents`);
    }
    defaultBudgetCents = Math.min(parsed, MAX_ISSUE_BUDGET_CENTS);
  }

  const managementKey = env[MANAGEMENT_KEY_ENV];
  return {
    managementKey:
      managementKey === undefined || managementKey.trim() === '' ? undefined : managementKey.trim(),
    defaultBudgetCents,
  };
}
