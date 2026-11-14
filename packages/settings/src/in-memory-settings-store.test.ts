import { describe, expect, it } from 'vitest';
import { createInMemorySettingsStore } from './in-memory-settings-store';
import { settingsStoreContract } from './store-contract';

settingsStoreContract({ describe, it, expect }, () => createInMemorySettingsStore());
