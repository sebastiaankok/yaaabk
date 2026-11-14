import { describe, expect, it } from 'vitest';
import { createSecretCrypto, maskSecret } from './secret-crypto';

describe('createSecretCrypto', () => {
  it('round-trips a secret through encrypt and decrypt', () => {
    const crypto = createSecretCrypto({ secret: 'a'.repeat(32) });
    const ciphertext = crypto.encrypt('sk-or-v1-abc123');

    expect(ciphertext).not.toContain('sk-or-v1-abc123');
    expect(crypto.decrypt(ciphertext)).toBe('sk-or-v1-abc123');
  });

  it('cannot decrypt ciphertext produced under a different secret', () => {
    const ciphertext = createSecretCrypto({ secret: 'a'.repeat(32) }).encrypt('sk-or-v1-abc123');
    const other = createSecretCrypto({ secret: 'b'.repeat(32) });

    expect(() => other.decrypt(ciphertext)).toThrow();
  });
});

describe('maskSecret', () => {
  it('keeps a short prefix and the last four characters', () => {
    expect(maskSecret('sk-or-v1-abcdefgh1c96')).toBe('sk-or-…1c96');
  });

  it('fully hides short values except the last four characters', () => {
    expect(maskSecret('1c96')).toBe('…1c96');
  });
});
