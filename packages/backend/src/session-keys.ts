import {
  createOpenRouterApi,
  maxCompletionCostUsd,
  mintKey,
  revokeKey,
  usdFromCents,
  type ModelCatalogue,
  type OpenRouterApi,
} from '@yaaabk/cost-control';
import type { SessionKeyIssuer } from '@yaaabk/grill-me';

/** How long a session's key may live; the session itself is capped at 4 hours. */
export const SESSION_KEY_TTL_MS = 4 * 60 * 60 * 1000;

/** What the key issuer needs from the running backend. */
export interface SessionKeyIssuerOptions {
  /** Resolves the credential store per call, so Settings changes take effect. */
  credentials: () => Promise<{
    openrouterManagementKey?: string;
    defaultIssueBudgetCents?: number;
  }>;
  /** Environment fallback when Settings holds no management key. */
  envManagementKey?: string;
  /** Spending cap in cents when Settings holds no budget preference. */
  budgetCents: number;
  /**
   * Prices the selected model so a run can be refused before it starts when
   * neither its budget nor the account balance can cover one full reply.
   */
  catalogue?: ModelCatalogue;
  /** Key lifetime. Defaults to {@link SESSION_KEY_TTL_MS}. */
  ttlMs?: number;
  /** Builds the OpenRouter client for a management key. Defaults to HTTP. */
  api?: (managementKey: string) => OpenRouterApi;
  /** Injected clock. */
  now?: () => Date;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * What a paid model may reserve for one reply, in USD.
 *
 * OpenRouter checks this before streaming: a request asking for a model's full
 * reply limit is rejected unless the key and the account can cover it, even if
 * the model would stop far short.
 */
export interface CreditRequirement {
  /** The OpenCode model id, used only in the refusal message. */
  model: string;
  requiredUsd: number;
}

/** A key minted for one caller, returned once with its plaintext value. */
export interface IssuedOpenRouterKey {
  key: string;
  hash: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Why a key could not be minted. The caller uses this to decide whether the
 * Issue needs a human (its budget cannot cover a reply) or whether the problem
 * is a credential or provider failure.
 */
export type OpenRouterKeyFailureReason =
  'missing-credential' | 'reply-reservation' | 'account-credits' | 'other';

/** Either a freshly minted key or an actionable reason it could not be made. */
export type OpenRouterKeyResult =
  | { ok: true; value: IssuedOpenRouterKey }
  | {
      ok: false;
      message: string;
      /** Machine-readable cause, when the issuer can classify it. */
      reason?: OpenRouterKeyFailureReason;
      /** The model whose reply reservation was priced, for a budget refusal. */
      model?: string;
      /** Worst-case reply cost in USD that the budget could not cover. */
      requiredUsd?: number;
      /** The budget in USD that was checked, for a budget refusal. */
      budgetUsd?: number;
    };

/** Mints and revokes budgeted OpenRouter keys from the platform credential. */
export interface OpenRouterKeyIssuer {
  /**
   * Mints a key for a stable subject, optionally overriding the default budget.
   * A requirement refuses the key up front when the budget or account balance
   * cannot cover one full reply from the selected model.
   */
  mint(
    subject: string,
    budgetCents?: number,
    requirement?: CreditRequirement,
  ): Promise<OpenRouterKeyResult>;
  /** Deletes a key by hash. */
  revoke(hash: string): Promise<void>;
}

/** What the per-issue Agent key issuer exposes. */
export interface AgentKeyIssuer {
  /**
   * Mints a key capped at the Issue's budget for one attempt. Each attempt gets
   * its own short-lived key, so a leak cannot outlive the run that created it.
   */
  mint(
    issueId: string,
    budgetCents: number,
    attempt: number,
    model?: string,
  ): Promise<OpenRouterKeyResult>;
}

const MISSING_CREDENTIAL_MESSAGE =
  'OpenRouter is not configured: add a management key in Settings, or set OPENROUTER_MANAGEMENT_KEY, to run an agent or start a session.';

/** Formats a USD amount for an actionable refusal message. */
function usdLabel(usd: number): string {
  return usd > 0 && usd < 0.01 ? 'less than $0.01' : `$${usd.toFixed(2)}`;
}

/**
 * Reads the selected model's worst-case reply cost from the live catalogue.
 *
 * Returns `undefined` when the model is unknown or the catalogue is unavailable:
 * a preflight must never be the reason a run cannot start. Free models need no
 * check because their maximum cost is zero.
 */
async function creditRequirement(
  catalogue: ModelCatalogue | undefined,
  model: string | undefined,
): Promise<CreditRequirement | undefined> {
  if (catalogue === undefined || model === undefined || model.trim() === '') return undefined;
  const listed = await catalogue.list();
  if (!listed.ok) return undefined;
  const entry = listed.value.find((candidate) => candidate.id === model);
  if (entry === undefined) return undefined;
  const requiredUsd = maxCompletionCostUsd(entry);
  return requiredUsd > 0 ? { model, requiredUsd } : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the shared mint/revoke pair.
 *
 * The backend never reuses one key across runs and never exposes the plaintext
 * outside the runtime spec or the per-run Secret.
 */
export function createOpenRouterKeyIssuer(options: SessionKeyIssuerOptions): OpenRouterKeyIssuer {
  const ttlMs = options.ttlMs ?? SESSION_KEY_TTL_MS;
  const buildApi =
    options.api ?? ((managementKey: string) => createOpenRouterApi({ managementKey }));
  const logger = options.logger ?? { info: () => {}, error: () => {} };

  async function resolveCredentials(): Promise<{
    managementKey: string | undefined;
    budgetCents: number;
  }> {
    const stored = await options.credentials();
    const configured = stored.openrouterManagementKey?.trim();
    const fallback = options.envManagementKey?.trim();
    return {
      managementKey:
        configured !== undefined && configured !== ''
          ? configured
          : fallback === undefined || fallback === ''
            ? undefined
            : fallback,
      budgetCents: stored.defaultIssueBudgetCents ?? options.budgetCents,
    };
  }

  return {
    async mint(subject, budgetOverride, requirement) {
      const { managementKey, budgetCents } = await resolveCredentials();
      if (managementKey === undefined) {
        logger.error('openrouter key mint failed: no management credential', { subject });
        return { ok: false, message: MISSING_CREDENTIAL_MESSAGE, reason: 'missing-credential' };
      }
      const cents = budgetOverride ?? budgetCents;
      const api = buildApi(managementKey);
      if (requirement !== undefined && requirement.requiredUsd > 0) {
        // A key's limit and the account balance are both checked by OpenRouter
        // before a token is produced. Refuse here, before a Job exists, when
        // either cannot cover one full reply; the provider's own message names
        // neither the real cause nor the setting to change.
        const budgetUsd = usdFromCents(cents);
        if (budgetUsd < requirement.requiredUsd) {
          logger.error('openrouter key mint refused: budget below reply reservation', {
            subject,
            model: requirement.model,
          });
          return {
            ok: false,
            message: `The ${usdLabel(budgetUsd)} budget is below the ${usdLabel(requirement.requiredUsd)} ${requirement.model} can reserve for one reply. Raise the budget or choose a cheaper model.`,
            reason: 'reply-reservation',
            model: requirement.model,
            requiredUsd: requirement.requiredUsd,
            budgetUsd,
          };
        }
        try {
          const credits = await api.getCredits();
          if (credits.remainingUsd < requirement.requiredUsd) {
            logger.error('openrouter key mint refused: account credits below reply reservation', {
              subject,
              model: requirement.model,
            });
            return {
              ok: false,
              message: `The OpenRouter account has ${usdLabel(credits.remainingUsd)} in credits left, but ${requirement.model} can reserve up to ${usdLabel(requirement.requiredUsd)} for one reply. Add credits at https://openrouter.ai/settings/credits or choose a free model.`,
              reason: 'account-credits',
              model: requirement.model,
              requiredUsd: requirement.requiredUsd,
            };
          }
        } catch (error) {
          // A balance lookup is a convenience: the provider still enforces the
          // real limit, so never refuse a run because the check itself failed.
          logger.error('openrouter credit preflight failed', {
            subject,
            message: messageOf(error),
          });
        }
      }
      try {
        const minted = await mintKey(api, {
          subject,
          budgetCents: cents,
          ttlMs,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        return {
          ok: true,
          value: {
            key: minted.key,
            hash: minted.keyHash,
            expiresAt: minted.expiresAt,
            createdAt: minted.createdAt,
          },
        };
      } catch (error) {
        logger.error('openrouter key mint failed', { subject, message: messageOf(error) });
        return {
          ok: false,
          message: `Could not create the OpenRouter key: ${messageOf(error)}`,
          reason: 'other',
        };
      }
    },

    async revoke(hash) {
      const { managementKey } = await resolveCredentials();
      if (managementKey === undefined) {
        logger.error('openrouter key revoke skipped: no management credential', { keyHash: hash });
        return;
      }
      try {
        await revokeKey(buildApi(managementKey), hash);
      } catch (error) {
        logger.error('openrouter key revoke failed', { keyHash: hash, message: messageOf(error) });
        throw error;
      }
    },
  };
}

/**
 * Mints and revokes the per-session OpenRouter key from the platform's
 * management credential.
 */
export function createOpenRouterSessionKeys(options: SessionKeyIssuerOptions): SessionKeyIssuer {
  const issuer = createOpenRouterKeyIssuer(options);
  return {
    issue: async (sessionId, model) =>
      issuer.mint(
        `session-${sessionId}`,
        undefined,
        await creditRequirement(options.catalogue, model),
      ),
    revoke: (hash) => issuer.revoke(hash),
  };
}

/**
 * Mints the OpenRouter key each Agent attempt runs with, capped at the Issue's
 * budget. The Agent Manager calls this for manual spawns, retries and
 * CI-tracker fix attempts alike, so no run starts without a credential.
 */
export function createOpenRouterAgentKeys(options: SessionKeyIssuerOptions): AgentKeyIssuer {
  const issuer = createOpenRouterKeyIssuer(options);
  return {
    mint: async (issueId, budgetCents, attempt, model) =>
      issuer.mint(
        `agent-${issueId}-attempt-${attempt}`,
        budgetCents,
        await creditRequirement(options.catalogue, model),
      ),
  };
}
