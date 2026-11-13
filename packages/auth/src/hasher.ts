import { compare, hash } from 'bcryptjs';

/** bcrypt cost factor used in production. */
export const DEFAULT_BCRYPT_ROUNDS = 10;

export interface BcryptHasherOptions {
  /** Defaults to {@link DEFAULT_BCRYPT_ROUNDS}. Lower values speed up tests. */
  rounds?: number;
}

/**
 * The password-hashing port. Injected into the Auth Module so tests can swap
 * bcrypt for {@link createFakePasswordHasher} and avoid the key-derivation cost.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/** Builds the production hasher, backed by bcrypt. */
export function createBcryptHasher(options: BcryptHasherOptions = {}): PasswordHasher {
  const rounds = options.rounds ?? DEFAULT_BCRYPT_ROUNDS;

  return {
    hash: (password) => hash(password, rounds),
    async verify(password, digest) {
      try {
        return await compare(password, digest);
      } catch {
        return false;
      }
    },
  };
}
