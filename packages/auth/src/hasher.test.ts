import { describe, expect, it } from 'vitest';
import { createBcryptHasher } from './hasher';

const hasher = createBcryptHasher({ rounds: 4 });

describe('createBcryptHasher', () => {
  it('verifies the password it hashed', async () => {
    const digest = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('correct horse battery staple', digest)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const digest = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('wrong password', digest)).resolves.toBe(false);
  });

  it('salts each digest so equal passwords differ', async () => {
    const first = await hasher.hash('same-password');
    const second = await hasher.hash('same-password');

    expect(first).not.toBe(second);
    expect(first).not.toContain('same-password');
  });

  it('returns false for a malformed digest instead of throwing', async () => {
    await expect(hasher.verify('password', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});
