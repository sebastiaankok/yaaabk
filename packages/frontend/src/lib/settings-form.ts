import type { CredentialField, SettingsUpdate } from '@yaaabk/settings';

/**
 * How the Developer authenticates YAAABK with GitHub. The App is preferred:
 * it scopes access to an installation rather than the whole account.
 */
export type GitHubCredentialMode = 'app' | 'pat';

/** The credential fields per GitHub mode, used to clear the inactive mode. */
const FIELDS_BY_GITHUB_MODE: Record<GitHubCredentialMode, readonly GitHubField[]> = {
  app: ['githubAppId', 'githubPrivateKey', 'githubInstallationId'],
  pat: ['githubPat'],
};

/** The GitHub credential fields, as opposed to the OpenRouter ones. */
type GitHubField = 'githubAppId' | 'githubPrivateKey' | 'githubInstallationId' | 'githubPat';

/**
 * What the Developer typed on the Settings page. Blank means "leave the stored
 * credential unchanged" — stored secrets are never round-tripped to the browser.
 */
export interface SettingsFormInput {
  githubMode?: GitHubCredentialMode;
  githubAppId?: string;
  githubPrivateKey?: string;
  githubInstallationId?: string;
  githubPat?: string;
  openrouterManagementKey?: string;
  /** Dollars, as typed; converted to whole cents on the wire. */
  defaultIssueBudgetDollars?: string;
}

/** Converts a dollars input to whole cents, or undefined when unparseable. */
export function dollarsToCents(dollars: string): number | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(dollars.trim())) {
    return undefined;
  }
  const cents = Math.round(Number(dollars) * 100);
  return Number.isInteger(cents) ? cents : undefined;
}

/** Validates the budget input, returning an error message or undefined. */
export function validateBudgetDollars(dollars: string): string | undefined {
  const cents = dollarsToCents(dollars);
  if (cents === undefined) {
    return 'Enter the budget in dollars, e.g. 0.50';
  }
  if (cents < 1 || cents > 500) {
    return 'The per-issue budget must be between $0.01 and $5.00';
  }
  return undefined;
}

/**
 * Builds the PUT body from what the Developer typed.
 *
 * Blank fields are omitted (the backend leaves them unchanged); the credentials
 * belonging to the inactive GitHub mode are cleared, since only one mode can be
 * active at a time.
 */
export function toSettingsUpdate(
  input: SettingsFormInput,
  current: Partial<Record<CredentialField, string>>,
): SettingsUpdate {
  const update: SettingsUpdate = {};

  if (input.githubMode !== undefined) {
    const activeFields = new Set(FIELDS_BY_GITHUB_MODE[input.githubMode]);
    const allFields = [...FIELDS_BY_GITHUB_MODE.app, ...FIELDS_BY_GITHUB_MODE.pat];
    const stale = allFields.filter(
      (field) => !activeFields.has(field) && current[field] !== undefined,
    );
    if (stale.length > 0) {
      update.clear = stale;
    }
    if (input.githubMode === 'pat') {
      if (input.githubPat !== undefined && input.githubPat !== '') {
        update.githubPat = input.githubPat;
      }
    } else {
      if (input.githubAppId !== undefined && input.githubAppId !== '') {
        update.githubAppId = input.githubAppId;
      }
      if (input.githubPrivateKey !== undefined && input.githubPrivateKey !== '') {
        update.githubPrivateKey = input.githubPrivateKey;
      }
      if (input.githubInstallationId !== undefined && input.githubInstallationId !== '') {
        update.githubInstallationId = input.githubInstallationId;
      }
    }
  }

  if (input.openrouterManagementKey !== undefined && input.openrouterManagementKey !== '') {
    update.openrouterManagementKey = input.openrouterManagementKey;
  }

  if (
    input.defaultIssueBudgetDollars !== undefined &&
    input.defaultIssueBudgetDollars.trim() !== ''
  ) {
    const cents = dollarsToCents(input.defaultIssueBudgetDollars);
    if (cents !== undefined) {
      update.defaultIssueBudgetCents = cents;
    }
  }

  return update;
}
