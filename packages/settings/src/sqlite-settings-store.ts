import type { SettingsRecord, SettingsStore } from './types';

/**
 * The slice of a SQLite driver the store uses.
 *
 * Keeping it structural (rather than importing `bun:sqlite`) lets the adapter
 * be typed without Bun types and passed a real `bun:sqlite` `Database` from the
 * backend.
 */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SettingsRow {
  github_app_id: string | null;
  github_private_key: string | null;
  github_installation_id: string | null;
  github_pat: string | null;
  openrouter_management_key: string | null;
  default_issue_budget_cents: number | null;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  github_app_id TEXT,
  github_private_key TEXT,
  github_installation_id TEXT,
  github_pat TEXT,
  openrouter_management_key TEXT,
  default_issue_budget_cents INTEGER,
  updated_at TEXT NOT NULL
);
`;

const CIPHER_COLUMNS = [
  'github_app_id',
  'github_private_key',
  'github_installation_id',
  'github_pat',
  'openrouter_management_key',
] as const;

/** SQLite-backed {@link SettingsStore}; YAAABK keeps a single settings row. */
export function createSqliteSettingsStore(db: SqliteDatabase): SettingsStore {
  db.exec(SCHEMA);

  function rowToRecord(row: SettingsRow): SettingsRecord {
    const record: SettingsRecord = { updatedAt: row.updated_at };
    if (row.github_app_id !== null) record.githubAppId = row.github_app_id;
    if (row.github_private_key !== null) record.githubPrivateKey = row.github_private_key;
    if (row.github_installation_id !== null) record.githubInstallationId = row.github_installation_id;
    if (row.github_pat !== null) record.githubPat = row.github_pat;
    if (row.openrouter_management_key !== null) {
      record.openrouterManagementKey = row.openrouter_management_key;
    }
    if (row.default_issue_budget_cents !== null) {
      record.defaultIssueBudgetCents = row.default_issue_budget_cents;
    }
    return record;
  }

  return {
    load() {
      const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow | null;
      return row === null ? undefined : rowToRecord(row);
    },
    save(record) {
      db.prepare(
        `INSERT INTO settings (
          id, github_app_id, github_private_key, github_installation_id,
          github_pat, openrouter_management_key, default_issue_budget_cents, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          github_app_id = excluded.github_app_id,
          github_private_key = excluded.github_private_key,
          github_installation_id = excluded.github_installation_id,
          github_pat = excluded.github_pat,
          openrouter_management_key = excluded.openrouter_management_key,
          default_issue_budget_cents = excluded.default_issue_budget_cents,
          updated_at = excluded.updated_at`,
      ).run(
        record.githubAppId ?? null,
        record.githubPrivateKey ?? null,
        record.githubInstallationId ?? null,
        record.githubPat ?? null,
        record.openrouterManagementKey ?? null,
        record.defaultIssueBudgetCents ?? null,
        record.updatedAt,
      );
    },
  };
}
