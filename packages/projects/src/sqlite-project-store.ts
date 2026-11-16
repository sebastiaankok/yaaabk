import type { SkillLevel } from '@yaaabk/shared';
import { DuplicateProjectNameError } from './in-memory-project-store';
import type { Project, ProjectStore } from './types';

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

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  skill_level: string;
  repo_url: string;
  repo_full_name: string;
  namespace: string;
  deployed_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  description        TEXT NOT NULL,
  skill_level        TEXT NOT NULL,
  repo_url           TEXT NOT NULL,
  repo_full_name     TEXT NOT NULL,
  namespace          TEXT NOT NULL,
  deployed_commit_sha TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_created_at ON projects (created_at DESC);
`;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    skillLevel: row.skill_level as SkillLevel,
    repoUrl: row.repo_url,
    repoFullName: row.repo_full_name,
    namespace: row.namespace,
    deployedCommitSha: row.deployed_commit_sha ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueNameViolation(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('UNIQUE') && error.message.includes('name')
  );
}

/**
 * Builds the production {@link ProjectStore} on a SQLite database.
 *
 * The caller owns the database handle (the backend opens it with `bun:sqlite`);
 * the store only creates its table and issues statements.
 */
export function createSqliteProjectStore(database: SqliteDatabase): ProjectStore {
  database.exec(SCHEMA);

  const columns = database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  if (columns.some((col) => col.name === 'argo_app_name')) {
    database.exec('ALTER TABLE projects DROP COLUMN argo_app_name');
  }
  if (!columns.some((col) => col.name === 'deployed_commit_sha')) {
    database.exec('ALTER TABLE projects ADD COLUMN deployed_commit_sha TEXT');
  }

  return {
    create(project) {
      try {
        database
          .prepare(
            `INSERT INTO projects
               (id, name, description, skill_level, repo_url, repo_full_name, namespace, deployed_commit_sha, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            project.id,
            project.name,
            project.description,
            project.skillLevel,
            project.repoUrl,
            project.repoFullName,
            project.namespace,
            project.deployedCommitSha,
            project.createdAt,
            project.updatedAt,
          );
      } catch (error) {
        if (isUniqueNameViolation(error)) {
          throw new DuplicateProjectNameError(project.name);
        }
        throw error;
      }
    },

    get(id) {
      const row = database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
        ProjectRow | null | undefined;
      return row == null ? undefined : toProject(row);
    },

    getByName(name) {
      const row = database.prepare('SELECT * FROM projects WHERE name = ?').get(name) as
        ProjectRow | null | undefined;
      return row == null ? undefined : toProject(row);
    },

    list() {
      const rows = database
        .prepare('SELECT * FROM projects ORDER BY created_at DESC, id DESC')
        .all() as ProjectRow[];
      return rows.map(toProject);
    },

    update(project) {
      database
        .prepare(
          `UPDATE projects
             SET name = ?, description = ?, skill_level = ?, repo_url = ?, repo_full_name = ?,
                 namespace = ?, deployed_commit_sha = ?, created_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          project.name,
          project.description,
          project.skillLevel,
          project.repoUrl,
          project.repoFullName,
          project.namespace,
          project.deployedCommitSha,
          project.createdAt,
          project.updatedAt,
          project.id,
        );
    },

    delete(id) {
      database.prepare('DELETE FROM projects WHERE id = ?').run(id);
    },
  };
}
