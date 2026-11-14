import type { SettingsRecord, SettingsStore } from './types';

/** Ephemeral {@link SettingsStore} for tests; holds a single record in memory. */
export function createInMemorySettingsStore(): SettingsStore {
  let record: SettingsRecord | undefined;

  return {
    load: () => record,
    save(next) {
      record = next;
    },
  };
}
