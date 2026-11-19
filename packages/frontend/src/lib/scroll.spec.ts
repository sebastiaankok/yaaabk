import { describe, expect, it } from 'vitest';
import { AT_BOTTOM_THRESHOLD_PX, isAtBottom } from './scroll';

function metrics(scrollTop: number, scrollHeight: number, clientHeight: number) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe('isAtBottom', () => {
  it('is true when the element is scrolled to its last pixel', () => {
    expect(isAtBottom(metrics(400, 1000, 600))).toBe(true);
  });

  it('is true when the element is shorter than its viewport', () => {
    expect(isAtBottom(metrics(0, 200, 600))).toBe(true);
  });

  it('tolerates a sub-pixel gap at the bottom', () => {
    const gap = AT_BOTTOM_THRESHOLD_PX - 1;
    expect(isAtBottom(metrics(400 - gap, 1000, 600))).toBe(true);
  });

  it('is false once the reader has scrolled further than the threshold', () => {
    const gap = AT_BOTTOM_THRESHOLD_PX + 1;
    expect(isAtBottom(metrics(400 - gap, 1000, 600))).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    expect(isAtBottom(metrics(380, 1000, 600), 25)).toBe(true);
    expect(isAtBottom(metrics(380, 1000, 600), 10)).toBe(false);
  });
});
