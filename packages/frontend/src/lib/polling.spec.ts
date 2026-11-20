import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollWhileVisible } from './polling';

describe('pollWhileVisible', () => {
  let visible = true;
  let notify: (() => void) | null = null;
  let unsubscribe: () => void;
  let unsubscribed = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    unsubscribed = 0;
    unsubscribe = () => {
      unsubscribed += 1;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(poll: () => void, intervalMs = 10_000): () => void {
    return pollWhileVisible({
      intervalMs,
      poll,
      isVisible: () => visible,
      onVisibilityChange: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    });
  }

  it('polls every interval while the tab is visible', () => {
    const poll = vi.fn();
    start(poll);

    vi.advanceTimersByTime(30_000);

    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden and catches up when it returns', () => {
    const poll = vi.fn();
    start(poll);

    visible = false;
    notify?.();
    vi.advanceTimersByTime(30_000);
    expect(poll).not.toHaveBeenCalled();

    visible = true;
    notify?.();
    expect(poll).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('stops polling and listening when torn down', () => {
    const poll = vi.fn();
    const stop = start(poll);

    stop();
    vi.advanceTimersByTime(30_000);
    notify?.();

    expect(poll).not.toHaveBeenCalled();
    expect(unsubscribed).toBe(1);
  });
});
