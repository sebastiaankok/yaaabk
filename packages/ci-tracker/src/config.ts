/** Default seconds between polling passes. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** The shortest interval the API accepts, so a typo cannot hammer GitHub. */
export const MIN_POLL_INTERVAL_MS = 5_000;

/** The longest interval the API accepts. */
export const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The label YAAABK puts on the pull requests it opens and the tracker watches. */
export const AUTOMERGE_LABEL = 'automerge';

/** Whether an interval is one the tracker will accept. */
export function isValidInterval(ms: number): boolean {
  return Number.isInteger(ms) && ms >= MIN_POLL_INTERVAL_MS && ms <= MAX_POLL_INTERVAL_MS;
}
