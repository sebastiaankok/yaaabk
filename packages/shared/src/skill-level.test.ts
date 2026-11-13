import { describe, expect, it } from 'vitest';
import { SKILL_LEVELS, isSkillLevel } from './skill-level';

describe('isSkillLevel', () => {
  it('accepts every supported skill level', () => {
    for (const level of SKILL_LEVELS) {
      expect(isSkillLevel(level)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isSkillLevel('ninja')).toBe(false);
    expect(isSkillLevel(undefined)).toBe(false);
    expect(isSkillLevel(42)).toBe(false);
  });
});
