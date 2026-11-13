/// <reference types="bun" />
import { Database } from 'bun:sqlite';
import * as bunTest from 'bun:test';
import { createSqliteAuthStore, type SqliteDatabase } from './sqlite-auth-store';
import { authStoreContract, type StoreTestApi } from './store-contract';

/**
 * Holds the SQLite store to the same contract as the in-memory store. It runs
 * under `bun test` (not vitest) because `bun:sqlite` is Bun-only; see the
 * package's `test:integration` script.
 */
authStoreContract(bunTest as unknown as StoreTestApi, () =>
  createSqliteAuthStore(new Database(':memory:') as unknown as SqliteDatabase),
);
