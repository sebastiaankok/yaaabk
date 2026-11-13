import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common';

/**
 * The password rules a Developer's password must satisfy.
 *
 * The character-class rules give clear, immediate feedback while zxcvbn adds
 * the "is this a common/guessable password" judgement (its dictionary of
 * leaked passwords, keyboard patterns and repeats) that a simple regex cannot.
 */
zxcvbnOptions.setOptions({ dictionary: { ...dictionary }, graphs: adjacencyGraphs });

/** Minimum password length, per the Auth Module specification. */
export const DEFAULT_MIN_PASSWORD_LENGTH = 12;

/** zxcvbn scores below this are treated as common/guessable. */
const MIN_ZXCVBN_SCORE = 2;

/** Machine-readable reason a password was rejected. */
export type PasswordViolationCode =
  | 'too-short'
  | 'missing-uppercase'
  | 'missing-lowercase'
  | 'missing-digit'
  | 'missing-special'
  | 'too-common'
  | 'contains-username';

/** A single reason a password was rejected, with a human-readable explanation. */
export interface PasswordViolation {
  code: PasswordViolationCode;
  message: string;
}

export interface PasswordPolicyOptions {
  /** Overrides {@link DEFAULT_MIN_PASSWORD_LENGTH}. */
  minLength?: number;
  /** The Developer's username; a password containing it is rejected. */
  username?: string;
}

/**
 * The password policy port. Injected into the Auth Module so tests can supply a
 * permissive policy instead of exercising zxcvbn on every fixture.
 */
export interface PasswordPolicy {
  /** Returns every violation; an empty array means the password is acceptable. */
  check(password: string, options?: PasswordPolicyOptions): PasswordViolation[];
}

const CHARACTER_RULES: ReadonlyArray<{
  code: PasswordViolationCode;
  message: string;
  test: (password: string) => boolean;
}> = [
  {
    code: 'missing-lowercase',
    message: 'Add a lowercase letter.',
    test: (password) => /[a-z]/.test(password),
  },
  {
    code: 'missing-uppercase',
    message: 'Add an uppercase letter.',
    test: (password) => /[A-Z]/.test(password),
  },
  {
    code: 'missing-digit',
    message: 'Add a digit.',
    test: (password) => /[0-9]/.test(password),
  },
  {
    code: 'missing-special',
    message: 'Add a special character.',
    test: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

/** Builds the default password policy, backed by zxcvbn. */
export function createPasswordPolicy(): PasswordPolicy {
  return {
    check(password, options = {}) {
      const minLength = options.minLength ?? DEFAULT_MIN_PASSWORD_LENGTH;
      const violations: PasswordViolation[] = [];

      if (password.length < minLength) {
        violations.push({
          code: 'too-short',
          message: `Use at least ${minLength} characters.`,
        });
      }

      for (const rule of CHARACTER_RULES) {
        if (!rule.test(password)) {
          violations.push({ code: rule.code, message: rule.message });
        }
      }

      const username = options.username?.trim();
      if (username !== undefined && username.length > 0) {
        if (password.toLowerCase().includes(username.toLowerCase())) {
          violations.push({
            code: 'contains-username',
            message: 'Do not include your username in your password.',
          });
        }
      }

      if (zxcvbn(password).score < MIN_ZXCVBN_SCORE) {
        violations.push({
          code: 'too-common',
          message: 'This password is too common or predictable; choose a less guessable one.',
        });
      }

      return violations;
    },
  };
}
