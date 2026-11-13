import type { PasswordHasher } from './hasher';

/** Marks a digest produced by the fake hasher. */
const PREFIX = 'fake$';

/**
 * A dependency-free {@link PasswordHasher} for tests and for other modules that
 * need to stand up the Auth Module without paying bcrypt's key-derivation cost.
 *
 * It is deliberately NOT secure: the digest is the plaintext. Never use it
 * outside tests.
 */
export function createFakePasswordHasher(): PasswordHasher {
  return {
    hash: async (password) => `${PREFIX}${password}`,
    verify: async (password, digest) => digest === `${PREFIX}${password}`,
  };
}
