import type { BudgetStore } from './budget-store';
import type { BudgetRecord } from './types';

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

interface BudgetRow {
  issue_id: string;
  key_hash: string;
  budget_cents: number;
  spent_cents: number;
  attempt: number;
  expires_at: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issue_budgets (
  issue_id     TEXT PRIMARY KEY,
  key_hash     TEXT NOT NULL,
  budget_cents INTEGER NOT NULL,
  spent_cents  INTEGER NOT NULL DEFAULT 0,
  attempt      INTEGER NOT NULL DEFAULT 1,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
`;

function toRecord(row: BudgetRow): BudgetRecord {
  return {
    issueId: row.issue_id,
    keyHash: row.key_hash,
    budgetCents: row.budget_cents,
    spentCents: row.spent_cents,
    attempt: row.attempt,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * Adds a column a newer version of the store introduced, so databases created
 * before it keep working. `CREATE TABLE IF NOT EXISTS` is a no-op on an
 * existing table, so additive changes need an explicit step.
 */
function ensureColumn(
  database: SqliteDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Builds the production {@link BudgetStore} on a SQLite database.
 *
 * The record outlives the backend process, so a retry after a restart still
 * knows what earlier attempts spent rather than granting a fresh full budget.
 */
export function createSqliteBudgetStore(database: SqliteDatabase): BudgetStore {
  database.exec(SCHEMA);
  ensureColumn(database, 'issue_budgets', 'spent_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'issue_budgets', 'attempt', 'INTEGER NOT NULL DEFAULT 1');

  return {
    save(record) {
      database
        .prepare(
          `INSERT INTO issue_budgets
             (issue_id, key_hash, budget_cents, spent_cents, attempt, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET
             key_hash = excluded.key_hash,
             budget_cents = excluded.budget_cents,
             spent_cents = excluded.spent_cents,
             attempt = excluded.attempt,
             expires_at = excluded.expires_at,
             created_at = excluded.created_at`,
        )
        .run(
          record.issueId,
          record.keyHash,
          record.budgetCents,
          record.spentCents,
          record.attempt,
          record.expiresAt,
          record.createdAt,
        );
    },

    get(issueId) {
      const row = database
        .prepare('SELECT * FROM issue_budgets WHERE issue_id = ?')
        .get(issueId) as BudgetRow | null | undefined;
      return row == null ? undefined : toRecord(row);
    },

    delete(issueId) {
      database.prepare('DELETE FROM issue_budgets WHERE issue_id = ?').run(issueId);
    },
  };
}
