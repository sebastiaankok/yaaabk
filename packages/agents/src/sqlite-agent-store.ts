import { isTokenUsage } from '@yaaabk/shared';
import { agentsError } from './errors';
import {
  isAgentRunKind,
  isAgentRunStatus,
  type AgentReviewVerdict,
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
  kind: string;
  attempt_number: number;
  pull_number: number | null;
  commit_sha: string | null;
  job_name: string | null;
  pvc_name: string | null;
  openrouter_secret_name: string | null;
  branch: string | null;
  review_feedback: string | null;
  status: string;
  model: string | null;
  pr_url: string | null;
  review_verdict: string | null;
  review_body: string | null;
  logs: string | null;
  cost_cents: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
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
  kind           TEXT NOT NULL DEFAULT 'implement-issue',
  attempt_number INTEGER NOT NULL,
  pull_number    INTEGER,
  commit_sha     TEXT,
  job_name       TEXT,
  pvc_name       TEXT,
  openrouter_secret_name TEXT,
  branch         TEXT,
  review_feedback TEXT,
  status         TEXT NOT NULL,
  model          TEXT,
  pr_url         TEXT,
  review_verdict TEXT,
  review_body    TEXT,
  logs           TEXT,
  cost_cents     INTEGER NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  token_hash     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS agent_runs_project_created ON agent_runs (project_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_runs_issue ON agent_runs (project_id, issue_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs (status);
`;

/** Narrows a stored column to a review verdict. */
function isReviewVerdict(value: unknown): value is AgentReviewVerdict {
  return value === 'approve' || value === 'request-changes';
}

function toRun(row: AgentRunRow): StoredAgentRun {
  const tokens = {
    input: row.input_tokens,
    output: row.output_tokens,
    reasoning: row.reasoning_tokens,
    cache: { read: row.cache_read_tokens, write: row.cache_write_tokens },
  };
  return {
    id: row.id,
    projectId: row.project_id,
    issueId: row.issue_id,
    kind: isAgentRunKind(row.kind) ? row.kind : 'implement-issue',
    attemptNumber: row.attempt_number,
    pullNumber: row.pull_number,
    commitSha: row.commit_sha ?? null,
    jobName: row.job_name,
    pvcName: row.pvc_name,
    openrouterSecretName: row.openrouter_secret_name,
    branch: row.branch,
    reviewFeedback: row.review_feedback,
    status: isAgentRunStatus(row.status) ? row.status : 'queued',
    model: row.model ?? null,
    prUrl: row.pr_url,
    reviewVerdict: isReviewVerdict(row.review_verdict) ? row.review_verdict : null,
    reviewBody: row.review_body ?? null,
    logs: row.logs,
    costCents: row.cost_cents,
    tokens: isTokenUsage(tokens) ? tokens : null,
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
  ensureColumn(database, 'agent_runs', 'branch', 'TEXT');
  ensureColumn(database, 'agent_runs', 'kind', "TEXT NOT NULL DEFAULT 'implement-issue'");
  ensureColumn(database, 'agent_runs', 'pull_number', 'INTEGER');
  ensureColumn(database, 'agent_runs', 'commit_sha', 'TEXT');
  ensureColumn(database, 'agent_runs', 'review_feedback', 'TEXT');
  ensureColumn(database, 'agent_runs', 'model', 'TEXT');
  ensureColumn(database, 'agent_runs', 'review_verdict', 'TEXT');
  ensureColumn(database, 'agent_runs', 'review_body', 'TEXT');
  ensureColumn(database, 'agent_runs', 'input_tokens', 'INTEGER');
  ensureColumn(database, 'agent_runs', 'output_tokens', 'INTEGER');
  ensureColumn(database, 'agent_runs', 'reasoning_tokens', 'INTEGER');
  ensureColumn(database, 'agent_runs', 'cache_read_tokens', 'INTEGER');
  ensureColumn(database, 'agent_runs', 'cache_write_tokens', 'INTEGER');

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
             (id, project_id, issue_id, kind, attempt_number, pull_number, commit_sha, job_name, pvc_name,
              openrouter_secret_name, branch, review_feedback, status, model, pr_url,
              review_verdict, review_body, logs, cost_cents,
              input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
              token_hash, created_at, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.issueId,
          run.kind,
          run.attemptNumber,
          run.pullNumber,
          run.commitSha,
          run.jobName,
          run.pvcName,
          run.openrouterSecretName,
          run.branch,
          run.reviewFeedback,
          run.status,
          run.model,
          run.prUrl,
          run.reviewVerdict,
          run.reviewBody,
          run.logs,
          run.costCents,
          run.tokens?.input ?? null,
          run.tokens?.output ?? null,
          run.tokens?.reasoning ?? null,
          run.tokens?.cache.read ?? null,
          run.tokens?.cache.write ?? null,
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
             project_id = ?, issue_id = ?, kind = ?, attempt_number = ?, pull_number = ?,
             commit_sha = ?, job_name = ?, pvc_name = ?,
             openrouter_secret_name = ?, branch = ?, review_feedback = ?, status = ?, model = ?,
             pr_url = ?, review_verdict = ?, review_body = ?, logs = ?,
             cost_cents = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
             cache_read_tokens = ?, cache_write_tokens = ?,
             token_hash = ?, started_at = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          run.projectId,
          run.issueId,
          run.kind,
          run.attemptNumber,
          run.pullNumber,
          run.commitSha,
          run.jobName,
          run.pvcName,
          run.openrouterSecretName,
          run.branch,
          run.reviewFeedback,
          run.status,
          run.model,
          run.prUrl,
          run.reviewVerdict,
          run.reviewBody,
          run.logs,
          run.costCents,
          run.tokens?.input ?? null,
          run.tokens?.output ?? null,
          run.tokens?.reasoning ?? null,
          run.tokens?.cache.read ?? null,
          run.tokens?.cache.write ?? null,
          run.tokenHash,
          run.startedAt,
          run.finishedAt,
          run.id,
        );
    },
  };
}
