import type { SkillLevel } from '@yaaabk/shared';
import { plansError } from './errors';
import type { Plan, PlanStore } from './types';

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

interface PlanRow {
  id: string;
  project_id: string;
  version: number;
  content_markdown: string;
  skill_level: string;
  source: string;
  created_at: string;
  is_active: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  version          INTEGER NOT NULL,
  content_markdown TEXT NOT NULL,
  skill_level      TEXT NOT NULL,
  source           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  is_active        INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS plans_project_version ON plans (project_id, version DESC);
CREATE INDEX IF NOT EXISTS plans_active ON plans (project_id, is_active) WHERE is_active = 1;
`;

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
    skillLevel: row.skill_level as SkillLevel,
    source: row.source as Plan['source'],
    createdAt: row.created_at,
    isActive: row.is_active === 1,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE');
}

/**
 * Builds the production {@link PlanStore} on a SQLite database.
 *
 * The caller owns the database handle (the backend opens it with `bun:sqlite`);
 * the store only creates its table and issues statements.
 */
export function createSqlitePlanStore(database: SqliteDatabase): PlanStore {
  database.exec(SCHEMA);

  function deactivateAll(projectId: string): void {
    database.prepare('UPDATE plans SET is_active = 0 WHERE project_id = ?').run(projectId);
  }

  return {
    create(plan) {
      database.exec('BEGIN');
      try {
        if (plan.isActive) {
          deactivateAll(plan.projectId);
        }
        database
          .prepare(
            `INSERT INTO plans
               (id, project_id, version, content_markdown, skill_level, source, created_at, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            plan.id,
            plan.projectId,
            plan.version,
            plan.contentMarkdown,
            plan.skillLevel,
            plan.source,
            plan.createdAt,
            plan.isActive ? 1 : 0,
          );
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        if (isUniqueViolation(error)) {
          throw plansError(
            'duplicate-version',
            `Plan version ${plan.version} already exists for project "${plan.projectId}"`,
          );
        }
        throw error;
      }
    },

    get(projectId, planId) {
      const row = database
        .prepare('SELECT * FROM plans WHERE project_id = ? AND id = ?')
        .get(projectId, planId) as PlanRow | null | undefined;
      return row == null ? undefined : toPlan(row);
    },

    list(projectId) {
      const rows = database
        .prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY version DESC, id DESC')
        .all(projectId) as PlanRow[];
      return rows.map(toPlan);
    },

    getActive(projectId) {
      const row = database
        .prepare('SELECT * FROM plans WHERE project_id = ? AND is_active = 1')
        .get(projectId) as PlanRow | null | undefined;
      return row == null ? undefined : toPlan(row);
    },

    nextVersion(projectId) {
      const row = database
        .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plans WHERE project_id = ?')
        .get(projectId) as { next: number } | null | undefined;
      return row?.next ?? 1;
    },

    activate(projectId, planId) {
      const target = database
        .prepare('SELECT id FROM plans WHERE project_id = ? AND id = ?')
        .get(projectId, planId) as { id: string } | null | undefined;
      if (target == null) {
        throw plansError('not-found', `No plan with id "${planId}" for project "${projectId}"`);
      }

      database.exec('BEGIN');
      try {
        deactivateAll(projectId);
        database
          .prepare('UPDATE plans SET is_active = 1 WHERE project_id = ? AND id = ?')
          .run(projectId, planId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
