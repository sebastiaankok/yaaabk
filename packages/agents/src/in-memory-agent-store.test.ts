import { describe, expect, it } from 'vitest';
import { createInMemoryAgentStore } from './in-memory-agent-store';
import { agentStoreContract } from './store-contract';

agentStoreContract({ describe, it, expect }, createInMemoryAgentStore);
