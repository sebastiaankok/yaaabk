import { describe, expect, it } from 'vitest';
import { createInMemoryIssueStore } from './in-memory-issue-store';
import { issueStoreContract } from './store-contract';

issueStoreContract({ describe, it, expect }, createInMemoryIssueStore);
