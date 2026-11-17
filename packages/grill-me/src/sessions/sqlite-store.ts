import type { GrillSessionRecord } from './session';
import type { GrillSessionStore } from './store';

/**
 * The slice of a SQLite driver the store uses. Kept structural so the adapter
 * is typed without Bun types and the backend passes its `bun:sqlite` handle.
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grill_sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS grill_sessions_project_status
  ON grill_sessions (project_id, status);
`;

/**
 * Stores the whole session record as JSON.
 *
 * The record is only ever read and written by the Grill-Me Module, so its shape
 * can evolve without a migration; the indexed columns exist for lookup and
 * operational queries, not as a second source of truth.
 */
export function createSqliteGrillSessionStore(database: SqliteDatabase): GrillSessionStore {
  database.exec(SCHEMA);

  return {
    save(session) {
      database
        .prepare(
          `INSERT INTO grill_sessions (id, project_id, status, started_at, ended_at, record_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             project_id = excluded.project_id,
             status = excluded.status,
             started_at = excluded.started_at,
             ended_at = excluded.ended_at,
             record_json = excluded.record_json`,
        )
        .run(
          session.id,
          session.projectId,
          session.status,
          session.startedAt,
          session.endedAt,
          JSON.stringify(session),
        );
    },

    get(sessionId) {
      const row = database
        .prepare('SELECT record_json FROM grill_sessions WHERE id = ?')
        .get(sessionId) as { record_json: string } | null | undefined;
      return row == null ? undefined : (JSON.parse(row.record_json) as GrillSessionRecord);
    },

    list() {
      const rows = database
        .prepare('SELECT record_json FROM grill_sessions ORDER BY started_at, id')
        .all() as Array<{ record_json: string }>;
      return rows.map((row) => JSON.parse(row.record_json) as GrillSessionRecord);
    },
  };
}
