import { Database } from 'bun:sqlite';
import * as bunTest from 'bun:test';
import { createSqliteSettingsStore, type SqliteDatabase } from './sqlite-settings-store';
import { settingsStoreContract, type StoreTestApi } from './store-contract';

/**
 * Holds the SQLite store to the same contract as the in-memory store. It runs
 * under `bun test` (not vitest) because `bun:sqlite` is Bun-only; see the
 * package's `test:integration` script.
 */
settingsStoreContract(bunTest as unknown as StoreTestApi, () =>
  createSqliteSettingsStore(new Database(':memory:') as unknown as SqliteDatabase),
);
