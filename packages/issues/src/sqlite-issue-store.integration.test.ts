/// <reference types="bun" />
import { Database } from 'bun:sqlite';
import * as bunTest from 'bun:test';
import { createSqliteIssueStore, type SqliteDatabase } from './sqlite-issue-store';
import { issueRecord, issueStoreContract, type StoreTestApi } from './store-contract';

/**
 * Holds the SQLite store to the same contract as the in-memory store. It runs
 * under `bun test` (not vitest) because `bun:sqlite` is Bun-only; see the
 * package's `test:integration` script.
 */
issueStoreContract(bunTest as unknown as StoreTestApi, () =>
  createSqliteIssueStore(new Database(':memory:') as unknown as SqliteDatabase),
);

const { describe, it, expect } = bunTest;

describe('sqlite issue store migrations', () => {
  it('adds github_synced_at to a database created before the column existed', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE issues (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL,
        plan_id             TEXT,
        github_number       INTEGER,
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
    `);

    const store = createSqliteIssueStore(database as unknown as SqliteDatabase);
    store.create(
      issueRecord({
        githubSyncedAt: '2026-02-01T00:00:00.000Z',
        summary: 'Create the bookmark tables.',
      }),
    );

    const stored = store.get('project-1', 'issue-1');
    expect(stored?.githubSyncedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(stored?.summary).toBe('Create the bookmark tables.');
  });

  it('leaves an older row without a summary null', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE issues (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL,
        plan_id             TEXT,
        github_number       INTEGER,
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
    `);
    database
      .prepare(
        `INSERT INTO issues
           (id, project_id, plan_id, github_number, title, body, status, label, depends_on,
            attempt_count, max_attempts, budget_cents, openrouter_key_hash, closed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'old',
        'project-1',
        null,
        null,
        'Old issue',
        'Body',
        'open',
        'ready',
        '[]',
        0,
        3,
        50,
        null,
        null,
        '2025-01-01',
      );

    const store = createSqliteIssueStore(database as unknown as SqliteDatabase);

    expect(store.get('project-1', 'old')?.summary).toBeNull();
  });
});
