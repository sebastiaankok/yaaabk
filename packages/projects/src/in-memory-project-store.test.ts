import { describe, expect, it } from 'vitest';
import { createInMemoryProjectStore } from './in-memory-project-store';
import { projectStoreContract } from './store-contract';

projectStoreContract({ describe, it, expect }, createInMemoryProjectStore);
