import { describe, expect, it } from 'vitest';
import { canForceFinish, finishHint } from './grill-finish';

describe('canForceFinish', () => {
  it('offers a forced publish only when the PRD exists and just the Issues are missing', () => {
    expect(canForceFinish(['issues'])).toBe(true);
    expect(canForceFinish(['prd'])).toBe(false);
    expect(canForceFinish(['prd', 'issues'])).toBe(false);
    expect(canForceFinish([])).toBe(false);
  });
});

describe('finishHint', () => {
  it('points a session without a PRD back to the terminal or cancel', () => {
    const hint = finishHint(['prd']);

    expect(hint).toMatch(/PRD/);
    expect(hint).toMatch(/terminal/i);
    expect(hint).toMatch(/cancel/i);
  });

  it('explains that only the Issue list is missing when the PRD exists', () => {
    const hint = finishHint(['issues']);

    expect(hint).toMatch(/issue/i);
    expect(hint).toMatch(/publish anyway/i);
  });

  it('has no hint when nothing is missing', () => {
    expect(finishHint([])).toBeNull();
  });
});
