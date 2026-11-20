import { describe, expect, it } from 'vitest';
import { PROJECT_MODES, isProjectMode } from './mode';

describe('PROJECT_MODES', () => {
  it('offers autonomous and guided, in that order', () => {
    expect(PROJECT_MODES).toEqual(['autonomous', 'guided']);
  });
});

describe('isProjectMode', () => {
  it('accepts every project mode', () => {
    for (const mode of PROJECT_MODES) {
      expect(isProjectMode(mode)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isProjectMode('ninja')).toBe(false);
    expect(isProjectMode(undefined)).toBe(false);
    expect(isProjectMode(42)).toBe(false);
  });
});
