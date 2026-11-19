/** The OpenRouter balance and affordability data the Settings page renders. */
export interface OpenRouterCreditsView {
  totalCreditsUsd: number;
  totalUsageUsd: number;
  remainingUsd: number;
  /** The model a paid run uses when nothing else chooses one. */
  defaultModel: string;
  /**
   * The most one maximum-length reply of the default model can reserve, in USD;
   * `null` when the catalogue could not price it.
   */
  reservationUsd: number | null;
}

/**
 * Formats a USD amount for the Settings page.
 *
 * A positive balance below one cent reads as "less than $0.01" rather than
 * "$0.00", which would suggest there is nothing left to spend.
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'less than $0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Explains why the default model would be refused before it runs, or `null`
 * when the balance covers one full reply (or cannot be priced).
 *
 * OpenRouter reserves a request against the account as if the model produced
 * its entire reply limit, so the comparison is against that worst case rather
 * than the amount the reply is expected to cost.
 */
export function affordabilityWarning(view: OpenRouterCreditsView): string | null {
  const reservationUsd = view.reservationUsd;
  if (reservationUsd === null || reservationUsd <= 0) return null;
  if (view.remainingUsd >= reservationUsd) return null;
  return `The OpenRouter account has ${formatUsd(view.remainingUsd)} in credits left, but ${view.defaultModel} can reserve up to ${formatUsd(reservationUsd)} for one reply. Add credits at https://openrouter.ai/settings/credits or choose a free model.`;
}
