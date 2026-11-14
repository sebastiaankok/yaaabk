import { issuesError } from './errors';
import { isIssueLabel, isIssueStatus, type Issue, type IssueStore } from './types';

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

interface IssueRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  github_number: number | null;
  github_synced_at: string | null;
  title: string;
  body: string;
  status: string;
  label: string;
  depends_on: string;
  attempt_count: number;
  max_attempts: number;
  budget_cents: number;
  openrouter_key_hash: string | null;
  closed_at: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  plan_id             TEXT,
  github_number       INTEGER,
  github_synced_at    TEXT,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL,
  label               TEXT NOT NULL,
  depends_on          TEXT NOT NULL,
  attempt_count       INTEGER NOT NULL,
  max_attempts        INTEGER NOT NULL,
  budget_cents        INTEGER NOT NULL,
  openrouter_key_hash TEXT,
  closed_at           TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (project_id, title)
);

CREATE INDEX IF NOT EXISTS issues_project_created ON issues (project_id, created_at, id);
CREATE INDEX IF NOT EXISTS issues_project_plan ON issues (project_id, plan_id);
`;

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    githubNumber: row.github_number,
    githubSyncedAt: row.github_synced_at,
    title: row.title,
    body: row.body,
    status: isIssueStatus(row.status) ? row.status : 'open',
    label: isIssueLabel(row.label) ? row.label : 'ready',
    dependsOn: JSON.parse(row.depends_on) as string[],
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    budgetCents: row.budget_cents,
    openrouterKeyHash: row.openrouter_key_hash,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE');
}

/**
 * Adds a column that a newer version of the store introduced, so databases
 * created before it keep working. `CREATE TABLE IF NOT EXISTS` is a no-op on an
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
 * Builds the production {@link IssueStore} on a SQLite database.
 *
 * The caller owns the database handle (the backend opens it with `bun:sqlite`);
 * the store only creates its table and issues statements.
 */
export function createSqliteIssueStore(database: SqliteDatabase): IssueStore {
  database.exec(SCHEMA);
  ensureColumn(database, 'issues', 'github_synced_at', 'TEXT');

  function requireRow(projectId: string, issueId: string): IssueRow {
    const row = database
      .prepare('SELECT * FROM issues WHERE project_id = ? AND id = ?')
      .get(projectId, issueId) as IssueRow | null | undefined;
    if (row == null) {
      throw issuesError('not-found', `No issue with id "${issueId}" for project "${projectId}"`);
    }
    return row;
  }

  function write(issue: Issue): void {
    try {
      database
        .prepare(
          `INSERT INTO issues
             (id, project_id, plan_id, github_number, github_synced_at, title, body, status, label,
              depends_on, attempt_count, max_attempts, budget_cents, openrouter_key_hash, closed_at,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          issue.id,
          issue.projectId,
          issue.planId,
          issue.githubNumber,
          issue.githubSyncedAt,
          issue.title,
          issue.body,
          issue.status,
          issue.label,
          JSON.stringify(issue.dependsOn),
          issue.attemptCount,
          issue.maxAttempts,
          issue.budgetCents,
          issue.openrouterKeyHash,
          issue.closedAt,
          issue.createdAt,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw issuesError(
          'duplicate-title',
          `Issue "${issue.title}" already exists for project "${issue.projectId}"`,
        );
      }
      throw error;
    }
  }

  return {
    create(issue) {
      write(issue);
    },

    get(projectId, issueId) {
      const row = database
        .prepare('SELECT * FROM issues WHERE project_id = ? AND id = ?')
        .get(projectId, issueId) as IssueRow | null | undefined;
      return row == null ? undefined : toIssue(row);
    },

    list(projectId) {
      const rows = database
        .prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY created_at ASC, id ASC')
        .all(projectId) as IssueRow[];
      return rows.map(toIssue);
    },

    update(issue) {
      requireRow(issue.projectId, issue.id);
      try {
        database
          .prepare(
            `UPDATE issues SET
               plan_id = ?, github_number = ?, github_synced_at = ?, title = ?, body = ?, status = ?,
               label = ?, depends_on = ?, attempt_count = ?, max_attempts = ?, budget_cents = ?,
               openrouter_key_hash = ?, closed_at = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(
            issue.planId,
            issue.githubNumber,
            issue.githubSyncedAt,
            issue.title,
            issue.body,
            issue.status,
            issue.label,
            JSON.stringify(issue.dependsOn),
            issue.attemptCount,
            issue.maxAttempts,
            issue.budgetCents,
            issue.openrouterKeyHash,
            issue.closedAt,
            issue.projectId,
            issue.id,
          );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw issuesError(
            'duplicate-title',
            `Issue "${issue.title}" already exists for project "${issue.projectId}"`,
          );
        }
        throw error;
      }
    },

    delete(projectId, issueId) {
      requireRow(projectId, issueId);
      database
        .prepare('DELETE FROM issues WHERE project_id = ? AND id = ?')
        .run(projectId, issueId);
    },
  };
}
