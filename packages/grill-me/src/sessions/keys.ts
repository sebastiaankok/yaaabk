/**
 * The lifecycle of a session's own OpenRouter key.
 *
 * A Grill-Me Session gets a budget-limited, expiring key so a runaway model
 * cannot spend without a ceiling. The plaintext key goes only into the runtime;
 * the orchestrator keeps the hash so it can revoke the key when the session
 * ends.
 */

/** A freshly minted session key and the handle used to revoke it. */
export interface SessionKey {
  /** Plaintext OpenRouter key. Goes only into the runtime. */
  key: string;
  /** OpenRouter key hash, stored on the session and used to revoke. */
  hash: string;
  /** ISO-8601 expiry, set when the key was minted. */
  expiresAt: string;
}

export type SessionKeyIssueResult =
  { ok: true; value: SessionKey } | { ok: false; message: string };

/** Mints and revokes the key a single session uses. */
export interface SessionKeyIssuer {
  /** Mints one key for the session. A failure names what to configure. */
  issue(sessionId: string): Promise<SessionKeyIssueResult>;
  /** Deletes the key by hash. Already-revoked keys are not an error. */
  revoke(hash: string): Promise<void>;
}
