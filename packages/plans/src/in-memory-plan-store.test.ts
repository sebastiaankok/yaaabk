import { describe, expect, it } from 'vitest';
import { createInMemoryPlanStore } from './in-memory-plan-store';
import { planStoreContract } from './store-contract';

planStoreContract({ describe, it, expect }, createInMemoryPlanStore);
