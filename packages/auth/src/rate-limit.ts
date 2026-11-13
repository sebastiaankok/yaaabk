/** Attempts permitted per window, per the Auth Module specification. */
export const DEFAULT_RATE_LIMIT = 5;

/** Length of the rate-limit window, in milliseconds. */
export const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface RateLimiterOptions {
  /** Attempts allowed per window. Defaults to {@link DEFAULT_RATE_LIMIT}. */
  limit?: number;
  /** Window length in milliseconds. Defaults to {@link DEFAULT_RATE_WINDOW_MS}. */
  windowMs?: number;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * A fixed-window attempt counter, keyed by client.
 *
 * Backed by an in-memory map: YAAABK is single-instance, so no shared store is
 * needed. Injected into the Auth Module so callers rate-limit credential
 * attempts without the module reaching for a clock or a global.
 */
export interface RateLimiter {
  /** Records an attempt and reports whether it is within the limit. */
  check(key: string): boolean;
  /** Attempts still available for `key` in the current window. */
  remaining(key: string): number;
  /** Clears the counter for `key`, or for every key when omitted. */
  reset(key?: string): void;
}

/** Builds the rate limiter. */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const limit = options.limit ?? DEFAULT_RATE_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_RATE_WINDOW_MS;
  const now = options.now ?? (() => new Date());

  const windows = new Map<string, { count: number; startedAt: number }>();

  function current(key: string): { count: number; startedAt: number } {
    const at = now().getTime();
    const existing = windows.get(key);
    if (existing === undefined || at - existing.startedAt >= windowMs) {
      const fresh = { count: 0, startedAt: at };
      windows.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    check(key) {
      const window = current(key);
      window.count += 1;
      return window.count <= limit;
    },
    remaining: (key) => Math.max(0, limit - current(key).count),
    reset(key) {
      if (key === undefined) {
        windows.clear();
        return;
      }
      windows.delete(key);
    },
  };
}
