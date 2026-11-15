import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toPkcs8Pem, unescapePemNewlines } from './private-key';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PKCS8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
/** The PKCS#8 header, taken from the fixture rather than spelled out here. */
const PKCS8_HEADER = PKCS8.trim().split('\n')[0]!;

describe('toPkcs8Pem', () => {
  it('converts the PKCS#1 key GitHub downloads', () => {
    const converted = toPkcs8Pem(PKCS1);

    expect(converted.startsWith(PKCS8_HEADER)).toBe(true);
    expect(createPrivateKey(converted).export({ type: 'pkcs1', format: 'pem' })).toBe(PKCS1);
  });

  it('passes a PKCS#8 key through unchanged in substance', () => {
    const converted = toPkcs8Pem(PKCS8);

    expect(converted.startsWith(PKCS8_HEADER)).toBe(true);
    expect(converted.trim()).toBe(PKCS8.trim());
  });

  it('rewrites escaped newlines before parsing', () => {
    expect(toPkcs8Pem(PKCS1.replace(/\n/g, '\\n'))).toBe(toPkcs8Pem(PKCS1));
  });

  it('throws on a value that is not a private key', () => {
    expect(() => toPkcs8Pem('not a key')).toThrow();
    expect(() => toPkcs8Pem('')).toThrow();
  });
});

describe('unescapePemNewlines', () => {
  it('leaves real line breaks alone', () => {
    expect(unescapePemNewlines('a\nb')).toBe('a\nb');
  });

  it('handles escaped carriage-return pairs', () => {
    expect(unescapePemNewlines('a\\r\\nb')).toBe('a\nb');
  });
});
