import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM recommended nonce size
const VERSION = 'v1';

export interface SecretCrypto {
  /** Encrypts a plaintext secret into a versioned, opaque ciphertext. */
  encrypt(plaintext: string): string;
  /** Decrypts a ciphertext produced by {@link encrypt}. */
  decrypt(ciphertext: string): string;
}

/**
 * Builds the masked hint shown to the Developer: a short prefix, an ellipsis,
 * and the last four characters — never enough to reconstruct the value.
 */
export function maskSecret(value: string): string {
  if (value.length >= 14) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  return `…${value.slice(-4)}`;
}

/**
 * Symmetric encryption for credentials at rest, keyed off `YAAABK_AUTH_SECRET`
 * via scrypt so the derived key is independent of the JWT signing use.
 */
export function createSecretCrypto({ secret }: { secret: string }): SecretCrypto {
  const key = scryptSync(secret, `yaaabk-settings-${VERSION}`, KEY_LENGTH);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
    },
    decrypt(ciphertext) {
      const [version, ivPart, dataPart, tagPart] = ciphertext.split(':');
      if (version !== VERSION || ivPart === undefined || dataPart === undefined || tagPart === undefined) {
        throw new Error('Unrecognized secret ciphertext format');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
