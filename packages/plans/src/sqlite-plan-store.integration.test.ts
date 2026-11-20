/// <reference types="bun" />
import { Database } from 'bun:sqlite';
import * as bunTest from 'bun:test';
import { createSqlitePlanStore, type SqliteDatabase } from './sqlite-plan-store';
import { planRecord, planStoreContract, type StoreTestApi } from './store-contract';

const { describe, expect, it } = bunTest;

/**
 * Holds the SQLite store to the same contract as the in-memory store. It runs
 * under `bun test` (not vitest) because `bun:sqlite` is Bun-only; see the
 * package's `test:integration` script.
 */
planStoreContract(bunTest as unknown as StoreTestApi, () =>
  createSqlitePlanStore(new Database(':memory:') as unknown as SqliteDatabase),
);

describe('sqlite plan store migrations', () => {
  it('adds the summary column to a database created before summaries', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE plans (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        version          INTEGER NOT NULL,
        content_markdown TEXT NOT NULL,
        mode      TEXT NOT NULL,
        source           TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        is_active        INTEGER NOT NULL,
        UNIQUE (project_id, version)
      );
    `);
    database
      .prepare(
        `INSERT INTO plans
           (id, project_id, version, content_markdown, mode, source, created_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('old', 'project-1', 1, '# Old plan', 'guided', 'grill-me', '2025-01-01', 1);

    const store = createSqlitePlanStore(database as unknown as SqliteDatabase);

    expect(store.get('project-1', 'old')?.summary).toBeNull();
    store.create(planRecord({ id: 'new', version: 2, summary: 'A newer plan.' }));
    expect(store.get('project-1', 'new')?.summary).toBe('A newer plan.');
  });

  it('adds the accepted_at column to a database created before acceptance', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE plans (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        version          INTEGER NOT NULL,
        content_markdown TEXT NOT NULL,
        summary          TEXT,
        mode      TEXT NOT NULL,
        source           TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        is_active        INTEGER NOT NULL,
        UNIQUE (project_id, version)
      );
    `);
    database
      .prepare(
        `INSERT INTO plans
           (id, project_id, version, content_markdown, mode, source, created_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('old', 'project-1', 1, '# Old plan', 'guided', 'grill-me', '2025-01-01', 1);

    const store = createSqlitePlanStore(database as unknown as SqliteDatabase);

    expect(store.get('project-1', 'old')?.acceptedAt).toBeNull();
    store.accept('project-1', 'old', '2026-02-01T00:00:00.000Z');
    expect(store.get('project-1', 'old')?.acceptedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});
