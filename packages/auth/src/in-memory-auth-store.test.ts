import * as vitest from 'vitest';
import { createInMemoryAuthStore } from './in-memory-auth-store';
import { authStoreContract, type StoreTestApi } from './store-contract';

authStoreContract(vitest as unknown as StoreTestApi, () => createInMemoryAuthStore());
