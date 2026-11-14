/** The credential fields of a {@link SettingsRecord}. */
export type CredentialField =
  | 'githubAppId'
  | 'githubPrivateKey'
  | 'githubInstallationId'
  | 'githubPat'
  | 'openrouterManagementKey';

/** A credential at rest: opaque ciphertext plus the masked hint shown in the UI. */
export interface CredentialValue {
  ciphertext: string;
  /** Computed from the plaintext when the credential was saved. */
  hint: string;
}

/**
 * The credential and preference row YAAABK persists for the single Developer
 * using this instance. Secret fields hold {@link CredentialValue}s — the store
 * never sees plaintext.
 */
export interface SettingsRecord {
  githubAppId?: CredentialValue;
  githubPrivateKey?: CredentialValue;
  githubInstallationId?: CredentialValue;
  githubPat?: CredentialValue;
  openrouterManagementKey?: CredentialValue;
  defaultIssueBudgetCents?: number;
  updatedAt: string;
}

export interface SettingsStore {
  /** Returns the stored record, or undefined before the first save. */
  load(): SettingsRecord | undefined;
  /** Overwrites the single settings row. */
  save(record: SettingsRecord): void;
}
