import { agentsError } from './errors';
import {
  isAgentRunStatus,
  type AgentRunStatus,
  type AgentStore,
  type StoredAgentRun,
} from './types';

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

interface AgentRunRow {
  id: string;
  project_id: string;
  issue_id: string;
  attempt_number: number;
  job_name: string | null;
  pvc_name: string | null;
  openrouter_secret_name: string | null;
  status: string;
  pr_url: string | null;
  logs: string | null;
  cost_cents: number;
  token_hash: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  issue_id       TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  job_name       TEXT,
  pvc_name       TEXT,
  openrouter_secret_name TEXT,
  status         TEXT NOT NULL,
  pr_url         TEXT,
  logs           TEXT,
  cost_cents     INTEGER NOT NULL,
  token_hash     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS agent_runs_project_created ON agent_runs (project_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_runs_issue ON agent_runs (project_id, issue_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs (status);
`;

function toRun(row: AgentRunRow): StoredAgentRun {
  return {
    id: row.id,
    projectId: row.project_id,
    issueId: row.issue_id,
    attemptNumber: row.attempt_number,
    jobName: row.job_name,
    pvcName: row.pvc_name,
    openrouterSecretName: row.openrouter_secret_name,
    status: isAgentRunStatus(row.status) ? row.status : 'queued',
    prUrl: row.pr_url,
    logs: row.logs,
    costCents: row.cost_cents,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Adds a column that a newer version of the store introduced, so databases
 * created before it keep working.
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
 * Builds the production {@link AgentStore} on a SQLite database.
 *
 * The caller owns the database handle (the backend opens it with `bun:sqlite`);
 * the store only creates its table and issues statements.
 */
export function createSqliteAgentStore(database: SqliteDatabase): AgentStore {
  database.exec(SCHEMA);
  ensureColumn(database, 'agent_runs', 'openrouter_secret_name', 'TEXT');

  function requireRow(runId: string): AgentRunRow {
    const row = database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as
      AgentRunRow | null | undefined;
    if (row == null) {
      throw agentsError('not-found', `No agent run with id "${runId}"`);
    }
    return row;
  }

  return {
    create(run) {
      database
        .prepare(
          `INSERT INTO agent_runs
             (id, project_id, issue_id, attempt_number, job_name, pvc_name, openrouter_secret_name,
              status, pr_url, logs, cost_cents, token_hash, created_at, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.issueId,
          run.attemptNumber,
          run.jobName,
          run.pvcName,
          run.openrouterSecretName,
          run.status,
          run.prUrl,
          run.logs,
          run.costCents,
          run.tokenHash,
          run.createdAt,
          run.startedAt,
          run.finishedAt,
        );
    },

    get(runId) {
      const row = database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as
        AgentRunRow | null | undefined;
      return row == null ? undefined : toRun(row);
    },

    listForProject(projectId) {
      const rows = database
        .prepare('SELECT * FROM agent_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC')
        .all(projectId) as AgentRunRow[];
      return rows.map(toRun);
    },

    listForIssue(projectId, issueId) {
      const rows = database
        .prepare(
          `SELECT * FROM agent_runs WHERE project_id = ? AND issue_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(projectId, issueId) as AgentRunRow[];
      return rows.map(toRun);
    },

    listActive() {
      const active: AgentRunStatus[] = ['queued', 'running'];
      const placeholders = active.map(() => '?').join(', ');
      const rows = database
        .prepare(
          `SELECT * FROM agent_runs WHERE status IN (${placeholders})
           ORDER BY created_at ASC, id ASC`,
        )
        .all(...active) as AgentRunRow[];
      return rows.map(toRun);
    },

    update(run) {
      requireRow(run.id);
      database
        .prepare(
          `UPDATE agent_runs SET
             project_id = ?, issue_id = ?, attempt_number = ?, job_name = ?, pvc_name = ?,
             openrouter_secret_name = ?, status = ?, pr_url = ?, logs = ?, cost_cents = ?,
             token_hash = ?, started_at = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          run.projectId,
          run.issueId,
          run.attemptNumber,
          run.jobName,
          run.pvcName,
          run.openrouterSecretName,
          run.status,
          run.prUrl,
          run.logs,
          run.costCents,
          run.tokenHash,
          run.startedAt,
          run.finishedAt,
          run.id,
        );
    },
  };
}
