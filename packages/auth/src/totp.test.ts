import { describe, expect, it } from 'vitest';
import { createTotp } from './totp';

/**
 * RFC 6238 Appendix B test vectors: the ASCII secret `12345678901234567890`
 * (base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`) at the given Unix second yields
 * the listed 8-digit HOTP value. The TOTP value is that truncated to 6 digits,
 * which is what these tests assert.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS: ReadonlyArray<{ epoch: number; token: string }> = [
  { epoch: 59, token: '287082' },
  { epoch: 1111111109, token: '081804' },
  { epoch: 1111111111, token: '050471' },
  { epoch: 1234567890, token: '005924' },
  { epoch: 2000000000, token: '279037' },
];

describe('generateSecret', () => {
  it('returns a base32 secret', () => {
    const secret = createTotp().generateSecret();

    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('returns a fresh secret every call', () => {
    const totp = createTotp();

    expect(totp.generateSecret()).not.toBe(totp.generateSecret());
  });
});

describe('keyUri', () => {
  it('renders a scannable otpauth URI with issuer and account', () => {
    const uri = createTotp({ issuer: 'YAAABK' }).keyUri({
      secret: RFC_SECRET,
      accountName: 'alice',
    });

    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('YAAABK:alice');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=YAAABK');
  });
});

describe('verify', () => {
  it.each(VECTORS)('accepts the RFC 6238 token for epoch $epoch', ({ epoch, token }) => {
    const totp = createTotp({ epoch: () => epoch * 1000 });

    expect(totp.verify({ secret: RFC_SECRET, token })).toBe(true);
  });

  it('rejects a token that does not match', () => {
    const totp = createTotp({ epoch: () => 59_000 });

    expect(totp.verify({ secret: RFC_SECRET, token: '000000' })).toBe(false);
  });

  it('rejects a non-numeric token', () => {
    const totp = createTotp({ epoch: () => 59_000 });

    expect(totp.verify({ secret: RFC_SECRET, token: 'abcdef' })).toBe(false);
  });

  it('tolerates the previous time step by default', () => {
    // 1111111109 and 1111111111 are adjacent 30-second steps.
    const previousStep = createTotp({ epoch: () => 1111111111 * 1000 });

    expect(previousStep.verify({ secret: RFC_SECRET, token: '081804' })).toBe(true);
  });

  it('does not tolerate an adjacent step when the window is zero', () => {
    const strict = createTotp({ epoch: () => 1111111111 * 1000, window: 0 });

    expect(strict.verify({ secret: RFC_SECRET, token: '081804' })).toBe(false);
  });
});
