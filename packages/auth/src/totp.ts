import { authenticator } from 'otplib';

/** Issuer shown in the Developer's authenticator app. */
export const DEFAULT_TOTP_ISSUER = 'YAAABK';

/** Number of digits in a generated code. */
export const DEFAULT_TOTP_DIGITS = 6;

/** Length of a time step, in seconds. */
export const DEFAULT_TOTP_PERIOD = 30;

/** Accept codes from this many steps either side of the current one. */
export const DEFAULT_TOTP_WINDOW = 1;

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  /** Shown alongside the account in the authenticator app. */
  issuer?: string;
  /** Defaults to {@link DEFAULT_TOTP_DIGITS}. */
  digits?: number;
  /** Time step in seconds. Defaults to {@link DEFAULT_TOTP_PERIOD}. */
  period?: number;
  /** Defaults to `sha1`, which every authenticator app supports. */
  algorithm?: TotpAlgorithm;
  /** Tolerated step drift. Defaults to {@link DEFAULT_TOTP_WINDOW}. */
  window?: number;
  /** Injected clock in milliseconds. Defaults to `Date.now`. */
  epoch?: () => number;
}

/** The TOTP port the Auth Module depends on. */
export interface Totp {
  /** Generates a fresh base32 secret. */
  generateSecret(): string;
  /** Renders the `otpauth://` URI that authenticator apps scan. */
  keyUri(input: { secret: string; accountName: string }): string;
  /** Whether `token` is valid for `secret` at the current time. */
  verify(input: { secret: string; token: string }): boolean;
}

/**
 * Builds a TOTP verifier on top of `otplib`.
 *
 * Each call runs against a private `Authenticator` instance whose options are
 * copied from the shared singleton (the only way to inherit otplib's crypto and
 * base32 plugins), so configuring one verifier never mutates another.
 */
export function createTotp(options: TotpOptions = {}): Totp {
  const issuer = options.issuer ?? DEFAULT_TOTP_ISSUER;
  const now = options.epoch ?? (() => Date.now());
  const overrides = {
    digits: options.digits ?? DEFAULT_TOTP_DIGITS,
    period: options.period ?? DEFAULT_TOTP_PERIOD,
    window: options.window ?? DEFAULT_TOTP_WINDOW,
    // otplib types `algorithm` as a string enum whose members equal these values.
    algorithm: (options.algorithm ?? 'sha1') as NonNullable<
      typeof authenticator.options
    >['algorithm'],
  };

  function instance(epochMs: number) {
    const instance = authenticator.create();
    instance.options = { ...authenticator.options, ...overrides, epoch: epochMs };
    return instance;
  }

  return {
    generateSecret: () => authenticator.generateSecret(),
    keyUri: ({ secret, accountName }) => instance(now()).keyuri(accountName, issuer, secret),
    verify: ({ secret, token }) => {
      if (!/^\d+$/.test(token)) {
        return false;
      }
      try {
        return instance(now()).check(token, secret);
      } catch {
        return false;
      }
    },
  };
}
