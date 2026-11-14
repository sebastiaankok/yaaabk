import type { CredentialValue, SettingsRecord, SettingsStore } from './types';

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

const CREDENTIAL_COLUMNS = [
  ['github_app_id', 'githubAppId'],
  ['github_private_key', 'githubPrivateKey'],
  ['github_installation_id', 'githubInstallationId'],
  ['github_pat', 'githubPat'],
  ['openrouter_management_key', 'openrouterManagementKey'],
] as const;

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

function encodeCredential(value: CredentialValue): string {
  return JSON.stringify(value);
}

function decodeCredential(json: string): CredentialValue {
  return JSON.parse(json) as CredentialValue;
}

/** SQLite-backed {@link SettingsStore}; YAAABK keeps a single settings row. */
export function createSqliteSettingsStore(db: SqliteDatabase): SettingsStore {
  db.exec(SCHEMA);

  function rowToRecord(row: SettingsRow): SettingsRecord {
    const record: SettingsRecord = { updatedAt: row.updated_at };
    for (const [column, field] of CREDENTIAL_COLUMNS) {
      const json = row[column];
      if (json !== null) {
        record[field] = decodeCredential(json);
      }
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
        ...CREDENTIAL_COLUMNS.map(([, field]) => {
          const value = record[field];
          return value === undefined ? null : encodeCredential(value);
        }),
        record.defaultIssueBudgetCents ?? null,
        record.updatedAt,
      );
    },
  };
}
