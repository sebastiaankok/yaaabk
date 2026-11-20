/** What to poll and how to tell whether the tab is on screen. */
export interface PollWhileVisibleOptions {
  /** How long to wait between polls. */
  intervalMs: number;
  /** The request to repeat. */
  poll: () => void | Promise<void>;
  /** Whether the tab is currently visible. */
  isVisible: () => boolean;
  /**
   * Subscribes to visibility changes and returns the matching unsubscribe.
   * Called once, when polling starts.
   */
  onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * Repeats `poll` every {@link PollWhileVisibleOptions.intervalMs} while the tab
 * is visible, and skips it while hidden so a background tab does not keep
 * hitting the API. Returning from a hidden tab polls once straight away rather
 * than leaving stale data on screen for a whole interval.
 *
 * Returns the teardown that clears the timer and the visibility subscription,
 * for use as a Svelte effect cleanup.
 */
export function pollWhileVisible({
  intervalMs,
  poll,
  isVisible,
  onVisibilityChange,
}: PollWhileVisibleOptions): () => void {
  let stopped = false;
  const tick = () => {
    if (!stopped && isVisible()) void poll();
  };
  const timer = setInterval(tick, intervalMs);
  const unsubscribe = onVisibilityChange(() => {
    if (!stopped && isVisible()) void poll();
  });

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
}
