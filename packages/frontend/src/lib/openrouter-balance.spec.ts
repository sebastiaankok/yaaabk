import { describe, expect, it } from 'vitest';
import { affordabilityWarning, formatUsd } from './openrouter-balance';

describe('formatUsd', () => {
  it('formats whole and fractional dollars to cents', () => {
    expect(formatUsd(40)).toBe('$40.00');
    expect(formatUsd(0.5)).toBe('$0.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('does not round a positive sub-cent balance up to one cent', () => {
    expect(formatUsd(0.0072)).toBe('less than $0.01');
  });
});

describe('affordabilityWarning', () => {
  const view = {
    totalCreditsUsd: 40,
    totalUsageUsd: 39.9928,
    remainingUsd: 0.0072,
    defaultModel: 'openrouter/anthropic/claude-sonnet-4.5',
    reservationUsd: 0.96,
  };

  it('names the balance, the reservation and the fix when the default model cannot reply', () => {
    const warning = affordabilityWarning(view);

    expect(warning).toContain('less than $0.01');
    expect(warning).toContain('$0.96');
    expect(warning).toContain('openrouter/anthropic/claude-sonnet-4.5');
    expect(warning).toContain('Add credits');
    expect(warning).toContain('free model');
  });

  it('stays quiet when the balance exactly covers one reply', () => {
    expect(affordabilityWarning({ ...view, remainingUsd: 0.96 })).toBeNull();
  });

  it('stays quiet for a healthy balance', () => {
    expect(affordabilityWarning({ ...view, remainingUsd: 1.5 })).toBeNull();
  });

  it('stays quiet when the default model cannot be priced', () => {
    expect(affordabilityWarning({ ...view, reservationUsd: null })).toBeNull();
  });

  it('stays quiet for a free default model', () => {
    expect(affordabilityWarning({ ...view, remainingUsd: 0, reservationUsd: 0 })).toBeNull();
  });
});
