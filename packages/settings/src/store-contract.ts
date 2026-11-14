import type { SettingsRecord, SettingsStore } from './types';

/**
 * The minimal test-framework surface the store contract needs.
 *
 * Declaring it structurally lets the same suite run under both vitest (the
 * in-memory store) and `bun:test` (the SQLite store), so the two adapters are
 * held to identical behaviour without duplicating the assertions.
 */
export interface StoreTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void): void;
  expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
  };
}

/** A complete {@link SettingsRecord}, overridable per test. */
export function settingsRecord(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    githubAppId: { ciphertext: 'enc-app-id', hint: '…p-id' },
    githubPrivateKey: { ciphertext: 'enc-private-key', hint: '…-key' },
    githubInstallationId: { ciphertext: 'enc-installation-id', hint: '…n-id' },
    githubPat: { ciphertext: 'enc-pat', hint: '…c-pat' },
    openrouterManagementKey: { ciphertext: 'enc-management-key', hint: '…1c96' },
    defaultIssueBudgetCents: 50,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Asserts that a {@link SettingsStore} implementation behaves as specified.
 *
 * Callers pass their framework's `describe`/`it`/`expect` and a factory that
 * returns a fresh, empty store.
 */
export function settingsStoreContract(api: StoreTestApi, createStore: () => SettingsStore): void {
  const { describe, it, expect } = api;

  describe('settings', () => {
    it('starts empty before the first save', () => {
      expect(createStore().load()).toBeUndefined();
    });

    it('stores and reads back the single record', () => {
      const store = createStore();
      store.save(settingsRecord());

      expect(store.load()).toEqual(settingsRecord());
    });

    it('overwrites the record on a later save', () => {
      const store = createStore();
      store.save(settingsRecord());
      store.save(
        settingsRecord({
          githubPat: { ciphertext: 'enc-new-pat', hint: '…-pat' },
          updatedAt: '2026-01-02T00:00:00.000Z',
        }),
      );

      expect(store.load()).toEqual(
        settingsRecord({
          githubPat: { ciphertext: 'enc-new-pat', hint: '…-pat' },
          updatedAt: '2026-01-02T00:00:00.000Z',
        }),
      );
    });
  });
}
