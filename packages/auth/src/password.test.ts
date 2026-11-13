import { describe, expect, it } from 'vitest';
import { createPasswordPolicy, type PasswordViolationCode } from './password';

const policy = createPasswordPolicy();

function codes(password: string, username?: string): PasswordViolationCode[] {
  return policy
    .check(password, username === undefined ? undefined : { username })
    .map((v) => v.code);
}

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(codes('vX7$qmPz2!Lw9Rt')).toEqual([]);
  });

  it('rejects passwords shorter than 12 characters', () => {
    expect(codes('Ab1!xyz')).toContain('too-short');
  });

  it('requires a lowercase letter', () => {
    expect(codes('VX7$QMPZ2!LW9RT')).toContain('missing-lowercase');
  });

  it('requires an uppercase letter', () => {
    expect(codes('vx7$qmpz2!lw9rt')).toContain('missing-uppercase');
  });

  it('requires a digit', () => {
    expect(codes('vX?$qmPz!!Lw?Rt')).toContain('missing-digit');
  });

  it('requires a special character', () => {
    expect(codes('vX7AqmPz2BLw9Rt')).toContain('missing-special');
  });

  it('rejects a common password even when it meets the character rules', () => {
    expect(codes('Password123!')).toContain('too-common');
  });

  it('rejects a password built from the username', () => {
    expect(codes('Sebastiaan1!x', 'sebastiaan')).toContain('contains-username');
  });

  it('explains every violation in plain language', () => {
    const violations = policy.check('short');

    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.message.trim().length).toBeGreaterThan(0);
    }
  });
});
