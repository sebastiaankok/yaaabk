/**
 * The credential and preference row YAAABK persists for the single Developer
 * using this instance. Secret fields hold opaque ciphertext produced by the
 * settings module's {@link SecretCrypto} — the store never sees plaintext.
 */
export interface SettingsRecord {
  githubAppId?: string;
  githubPrivateKey?: string;
  githubInstallationId?: string;
  githubPat?: string;
  openrouterManagementKey?: string;
  defaultIssueBudgetCents?: number;
  updatedAt: string;
}

export interface SettingsStore {
  /** Returns the stored record, or undefined before the first save. */
  load(): SettingsRecord | undefined;
  /** Overwrites the single settings row. */
  save(record: SettingsRecord): void;
}
