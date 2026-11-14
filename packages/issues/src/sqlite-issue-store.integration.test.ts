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
    store.create(issueRecord({ githubSyncedAt: '2026-02-01T00:00:00.000Z' }));

    expect(store.get('project-1', 'issue-1')?.githubSyncedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});
