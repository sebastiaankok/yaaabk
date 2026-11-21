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

/** The parts of the form that are saved and can be compared against a snapshot. */
export interface SettingsFormSnapshot {
  githubMode: GitHubCredentialMode;
  defaultIssueBudgetDollars: string;
}

/**
 * Whether the Developer has typed something that a save would send.
 *
 * Stored secrets never enter the form, so any non-blank credential is a change.
 */
export function hasUnsavedChanges(
  input: SettingsFormInput,
  snapshot: SettingsFormSnapshot,
): boolean {
  const credentials = [
    input.githubAppId,
    input.githubPrivateKey,
    input.githubInstallationId,
    input.githubPat,
    input.openrouterManagementKey,
  ];
  if (credentials.some((value) => value !== undefined && value !== '')) {
    return true;
  }
  if (input.githubMode !== undefined && input.githubMode !== snapshot.githubMode) {
    return true;
  }

  const budget = input.defaultIssueBudgetDollars?.trim() ?? '';
  if (budget === '') return false;
  const cents = dollarsToCents(budget);
  if (cents === undefined) return true;
  return cents !== dollarsToCents(snapshot.defaultIssueBudgetDollars);
}

/**
 * Where the save bar's state is in its lifecycle. Unlike the status shown in
 * the bar, this is what the page knows: saved and failed are outcomes of the
 * last save, not form contents.
 */
export type SettingsSavePhase = 'idle' | 'saving' | 'saved' | 'failed';

/** The states the sticky save bar must never hide. */
export type SaveBarStatus = 'clean' | 'unsaved' | 'saving' | 'saved' | 'failed';

/**
 * Resolves what the sticky save bar reports. A save in flight and a failed save
 * outrank form dirtiness, but a posted saved state only survives while the form
 * is still clean.
 */
export function saveBarStatus({
  dirty,
  phase,
}: {
  dirty: boolean;
  phase: SettingsSavePhase;
}): SaveBarStatus {
  if (phase === 'saving') return 'saving';
  if (phase === 'failed') return 'failed';
  if (dirty) return 'unsaved';
  return phase === 'saved' ? 'saved' : 'clean';
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
