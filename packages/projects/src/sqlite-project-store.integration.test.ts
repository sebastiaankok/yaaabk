/// <reference types="bun" />
import { Database } from 'bun:sqlite';
import * as bunTest from 'bun:test';
import { createSqliteProjectStore, type SqliteDatabase } from './sqlite-project-store';
import { projectStoreContract, type StoreTestApi } from './store-contract';

/**
 * Holds the SQLite store to the same contract as the in-memory store. It runs
 * under `bun test` (not vitest) because `bun:sqlite` is Bun-only; see the
 * package's `test:integration` script.
 */
projectStoreContract(bunTest as unknown as StoreTestApi, () =>
  createSqliteProjectStore(new Database(':memory:') as unknown as SqliteDatabase),
);
