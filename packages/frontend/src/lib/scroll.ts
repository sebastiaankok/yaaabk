/** The pixels of slack that still count as the bottom, covering sub-pixel rounding. */
export const AT_BOTTOM_THRESHOLD_PX = 4;

/** The scroll measurements of an element, enough to tell whether it is at the bottom. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the reader has reached the bottom of a scroll box.
 *
 * Anything within {@link AT_BOTTOM_THRESHOLD_PX} of the last pixel counts, so a
 * fractional layout height does not leave a panel that looks scrolled to the
 * end stuck in "following paused" mode. Content shorter than its viewport is
 * always at the bottom.
 */
export function isAtBottom(
  metrics: ScrollMetrics,
  threshold: number = AT_BOTTOM_THRESHOLD_PX,
): boolean {
  const remaining = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return remaining <= threshold;
}
