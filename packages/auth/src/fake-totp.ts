import type { Totp } from './totp';

export interface FakeTotpOptions {
  /** Secret every `generateSecret` call returns. */
  secret?: string;
  /** The only token `verify` accepts. */
  token?: string;
}

/**
 * A deterministic {@link Totp} for tests and for other modules that need the
 * Auth Module without running RFC 6238.
 *
 * It is deliberately predictable: one fixed secret, one fixed valid code. The
 * real implementation is covered by the RFC 6238 vectors in `totp.test.ts`.
 */
export function createFakeTotp(options: FakeTotpOptions = {}): Totp {
  const secret = options.secret ?? 'FAKESECRET';
  const token = options.token ?? '123456';

  return {
    generateSecret: () => secret,
    keyUri: ({ secret: used, accountName }) =>
      `otpauth://totp/YAAABK:${accountName}?secret=${used}&issuer=YAAABK`,
    verify: ({ token: provided }) => provided === token,
  };
}
