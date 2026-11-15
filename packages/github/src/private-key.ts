import { createPrivateKey } from 'node:crypto';

/**
 * Rewrites escaped newlines (`\\n`) into real line breaks.
 *
 * Keys pasted from a secret manager, a CI variable or a YAML literal often
 * arrive with the newlines escaped, which GitHub rejects as malformed.
 */
export function unescapePemNewlines(pem: string): string {
  return pem.replace(/\\r\\n|\\n|\\r/g, '\n');
}

/**
 * Normalizes a GitHub App private key into a PKCS#8 PEM string.
 *
 * GitHub hands out PKCS#1 keys (`-----BEGIN RSA PRIVATE KEY-----`) while the
 * WebCrypto API `jose` uses only speaks PKCS#8. Rather than making every
 * Developer run `openssl pkcs8 -topk8` before pasting their key, both PKCS#1
 * and PKCS#8 are accepted here and normalized to PKCS#8.
 *
 * Throws when the value is not a readable private key; callers turn that into a
 * credential failure.
 */
export function toPkcs8Pem(privateKey: string): string {
  const normalized = unescapePemNewlines(privateKey).trim();
  const key = createPrivateKey(normalized);
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}
