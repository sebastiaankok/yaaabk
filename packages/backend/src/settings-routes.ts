import type { SettingsError, SettingsErrorKind, SettingsModule, SettingsUpdate } from '@yaaabk/settings';
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

/** Credential fields accepted on the wire, in wire (snake_case) and TS form. */
const CREDENTIAL_KEYS: ReadonlyArray<readonly [string, keyof SettingsUpdate]> = [
  ['github_app_id', 'githubAppId'],
  ['github_private_key', 'githubPrivateKey'],
  ['github_installation_id', 'githubInstallationId'],
  ['github_pat', 'githubPat'],
  ['openrouter_management_key', 'openrouterManagementKey'],
];

const CLEAR_FIELDS: ReadonlySet<string> = new Set([
  'github_app_id',
  'github_private_key',
  'github_installation_id',
  'github_pat',
  'openrouter_management_key',
]);

/** Builds the `/api/settings*` routes. */
export function settingsRoutes(settings: SettingsModule): Hono {
  const app = new Hono();

  app.get('/api/settings', async (c) => {
    const view = await settings.get();
    return c.json(view);
  });

  app.put('/api/settings', async (c) => {    const input = await body(c);
    const update: SettingsUpdate = {};
    for (const [wireKey, field] of CREDENTIAL_KEYS) {
      const value = input[wireKey];
      if (typeof value === 'string' && value !== '') {
        (update[field] as unknown) = value;
      }
    }
    const budget = input.default_issue_budget_cents;
    if (budget !== undefined) {
      update.defaultIssueBudgetCents = typeof budget === 'number' ? budget : Number.NaN;
    }
    if (Array.isArray(input.clear)) {
      update.clear = input.clear.filter(
        (field): field is string => typeof field === 'string' && CLEAR_FIELDS.has(field),
      ) as SettingsUpdate['clear'];
    }
    const result = await settings.update(update);
    return result.ok ? c.json(result.value) : fail(c, result.error);
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
