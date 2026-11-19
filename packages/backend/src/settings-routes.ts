import {
  maxCompletionCostUsd,
  type ModelCatalogue,
  type OpenRouterCredits,
} from '@yaaabk/cost-control';
import type {
  CredentialField,
  SettingsError,
  SettingsErrorKind,
  SettingsModule,
  SettingsUpdate,
} from '@yaaabk/settings';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const STATUS_BY_KIND: Record<SettingsErrorKind, ContentfulStatusCode> = {
  'invalid-input': 400,
  // A failed verify is the Developer's input problem, not a session problem —
  // the session is already authenticated by the middleware.
  unauthorized: 400,
  network: 502,
  server: 502,
  'rate-limited': 429,
};

function fail(c: Context, error: SettingsError) {
  return c.json({ error: error.kind, message: error.message }, STATUS_BY_KIND[error.kind]);
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Credential fields accepted on the wire, in wire (snake_case) and TS
 * (camelCase) form. The browser sends the camelCase `SettingsUpdate` shape
 * directly, so both spellings must resolve to the same field.
 */
const CREDENTIAL_KEYS: ReadonlyArray<readonly [string, keyof SettingsUpdate]> = [
  ['github_app_id', 'githubAppId'],
  ['githubAppId', 'githubAppId'],
  ['github_private_key', 'githubPrivateKey'],
  ['githubPrivateKey', 'githubPrivateKey'],
  ['github_installation_id', 'githubInstallationId'],
  ['githubInstallationId', 'githubInstallationId'],
  ['github_pat', 'githubPat'],
  ['githubPat', 'githubPat'],
  ['openrouter_management_key', 'openrouterManagementKey'],
  ['openrouterManagementKey', 'openrouterManagementKey'],
];

/** Maps either wire spelling of a clearable field to its canonical TS name. */
const CLEAR_FIELD_ALIASES: Readonly<Record<string, CredentialField>> = {
  github_app_id: 'githubAppId',
  githubAppId: 'githubAppId',
  github_private_key: 'githubPrivateKey',
  githubPrivateKey: 'githubPrivateKey',
  github_installation_id: 'githubInstallationId',
  githubInstallationId: 'githubInstallationId',
  github_pat: 'githubPat',
  githubPat: 'githubPat',
  openrouter_management_key: 'openrouterManagementKey',
  openrouterManagementKey: 'openrouterManagementKey',
};

/** What the Settings page needs to explain an unaffordable balance. */
export interface OpenRouterCreditsView extends OpenRouterCredits {
  /** The model a paid run uses when nothing else chooses one. */
  defaultModel: string;
  /**
   * The most one maximum-length reply of the default model can reserve, in USD;
   * `null` when the catalogue cannot price it. The UI warns only when the
   * remaining balance is below this amount.
   */
  reservationUsd: number | null;
}

export interface SettingsRoutesOptions {
  /** Prices the default model so the UI can warn before a run is refused. */
  catalogue?: ModelCatalogue;
  /** The default model paid runs use when nothing else chooses one. */
  defaultModel?: string;
}

/** The worst-case reply cost of the default model, when it can be priced. */
async function defaultReservationUsd(
  catalogue: ModelCatalogue | undefined,
  defaultModel: string | undefined,
): Promise<number | null> {
  if (catalogue === undefined || defaultModel === undefined || defaultModel === '') return null;
  const listed = await catalogue.list();
  if (!listed.ok) return null;
  const model = listed.value.find((candidate) => candidate.id === defaultModel);
  return model === undefined ? null : maxCompletionCostUsd(model);
}

/** Builds the `/api/settings*` routes. */
export function settingsRoutes(
  settings: SettingsModule,
  options: SettingsRoutesOptions = {},
): Hono {
  const app = new Hono();

  app.get('/api/settings', async (c) => {
    const view = await settings.get();
    return c.json(view);
  });

  app.put('/api/settings', async (c) => {
    const input = await body(c);
    const update: SettingsUpdate = {};
    for (const [wireKey, field] of CREDENTIAL_KEYS) {
      const value = input[wireKey];
      if (typeof value === 'string' && value !== '') {
        (update[field] as unknown) = value;
      }
    }
    const budget = input.default_issue_budget_cents ?? input.defaultIssueBudgetCents;
    if (budget !== undefined) {
      update.defaultIssueBudgetCents = typeof budget === 'number' ? budget : Number.NaN;
    }
    if (Array.isArray(input.clear)) {
      const clear = input.clear
        .filter((field): field is string => typeof field === 'string')
        .map((field) => CLEAR_FIELD_ALIASES[field])
        .filter((field): field is CredentialField => field !== undefined);
      if (clear.length > 0) {
        update.clear = clear;
      }
    }
    const result = await settings.update(update);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.get('/api/settings/openrouter/credits', async (c) => {
    const result = await settings.credits();
    if (!result.ok) return fail(c, result.error);
    const view: OpenRouterCreditsView = {
      ...result.value,
      defaultModel: options.defaultModel ?? '',
      reservationUsd: await defaultReservationUsd(options.catalogue, options.defaultModel),
    };
    return c.json(view);
  });

  app.post('/api/settings/openrouter/verify', async (c) => {
    const result = await settings.verifyOpenRouter();
    return result.ok ? c.json({ ok: true, ...result.value }) : fail(c, result.error);
  });

  app.post('/api/settings/github/verify', async (c) => {
    const result = await settings.verifyGitHub();
    return result.ok ? c.json({ ok: true, ...result.value }) : fail(c, result.error);
  });

  return app;
}
