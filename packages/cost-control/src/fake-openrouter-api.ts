import { OpenRouterApiError } from './errors';
import type {
  CreateKeyInput,
  CreatedOpenRouterKey,
  OpenRouterApi,
  OpenRouterKey,
  UpdateKeyInput,
} from './openrouter-api';

/** An operation the fake can be told to fail, used to exercise error mapping. */
export type FakeOpenRouterOperation = 'createKey' | 'updateKey' | 'getKey' | 'deleteKey';

/**
 * The in-memory OpenRouter Management API used by unit tests.
 *
 * It mimics the real endpoints closely enough to drive the module through every
 * behaviour: keys get sequential hashes and `sk-or-v1-...` plaintext, spending
 * caps behave like OpenRouter's, and failures can be queued per operation.
 */
export interface FakeOpenRouterApi extends OpenRouterApi {
  /** Operations called, in order, for asserting on the module's API usage. */
  readonly calls: FakeOpenRouterOperation[];
  /** The most recent `createKey` payload, for asserting on the requested budget. */
  readonly lastCreate: CreateKeyInput | undefined;
  /** The most recent `updateKey` call, for asserting on limit changes. */
  readonly lastUpdate: { hash: string; input: UpdateKeyInput } | undefined;
  /** Keys created so far, newest last, including their plaintext. */
  readonly created: CreatedOpenRouterKey[];
  /** Simulates spend against a key, so `getKey` reports less remaining budget. */
  setUsage(hash: string, usageUsd: number): void;
  /** Disables or re-enables a key, as an operator would in the dashboard. */
  setDisabled(hash: string, disabled: boolean): void;
  /** Queues `error` for the next call to `operation`. */
  fail(operation: FakeOpenRouterOperation, error: Error): void;
}

/** Builds the fake OpenRouter API. */
export function createFakeOpenRouterApi(): FakeOpenRouterApi {
  const calls: FakeOpenRouterOperation[] = [];
  const created: CreatedOpenRouterKey[] = [];
  const keys = new Map<string, { info: OpenRouterKey; plaintext: string }>();
  const usageByHash = new Map<string, number>();
  const failures = new Map<FakeOpenRouterOperation, Error>();
  let lastCreate: CreateKeyInput | undefined;
  let lastUpdate: { hash: string; input: UpdateKeyInput } | undefined;
  let counter = 0;

  function maybeFail(operation: FakeOpenRouterOperation): void {
    const error = failures.get(operation);
    if (error !== undefined) {
      failures.delete(operation);
      throw error;
    }
  }

  function infoOf(hash: string): OpenRouterKey {
    const entry = keys.get(hash);
    if (entry === undefined) {
      throw new OpenRouterApiError(`API key not found: ${hash}`, { statusCode: 404 });
    }
    const usageUsd = usageByHash.get(hash) ?? 0;
    const limitUsd = entry.info.limitUsd;
    return {
      ...entry.info,
      usageUsd,
      limitRemainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - usageUsd),
    };
  }

  return {
    calls,
    created,
    get lastCreate() {
      return lastCreate;
    },
    get lastUpdate() {
      return lastUpdate;
    },

    async createKey(input: CreateKeyInput) {
      calls.push('createKey');
      lastCreate = input;
      maybeFail('createKey');
      counter += 1;
      const hash = `hash-${counter}`;
      const plaintext = `sk-or-v1-${counter}`;
      const info: OpenRouterKey = {
        hash,
        name: input.name,
        disabled: false,
        limitUsd: input.limitUsd,
        limitRemainingUsd: input.limitUsd,
        usageUsd: 0,
        expiresAt: input.expiresAt,
        createdAt: new Date(0).toISOString(),
      };
      keys.set(hash, { info, plaintext });
      const createdKey: CreatedOpenRouterKey = { key: plaintext, keyInfo: info };
      created.push(createdKey);
      return createdKey;
    },

    async updateKey(hash: string, input: UpdateKeyInput) {
      calls.push('updateKey');
      lastUpdate = { hash, input };
      maybeFail('updateKey');
      const entry = keys.get(hash);
      if (entry === undefined) {
        throw new OpenRouterApiError(`API key not found: ${hash}`, { statusCode: 404 });
      }
      if (input.limitUsd !== undefined) {
        entry.info = { ...entry.info, limitUsd: input.limitUsd };
      }
      if (input.disabled !== undefined) {
        entry.info = { ...entry.info, disabled: input.disabled };
      }
      return infoOf(hash);
    },

    async getKey(hash: string) {
      calls.push('getKey');
      maybeFail('getKey');
      return infoOf(hash);
    },

    async deleteKey(hash: string) {
      calls.push('deleteKey');
      maybeFail('deleteKey');
      if (!keys.has(hash)) {
        throw new OpenRouterApiError(`API key not found: ${hash}`, { statusCode: 404 });
      }
      keys.delete(hash);
      usageByHash.delete(hash);
    },

    setUsage(hash, usageUsd) {
      usageByHash.set(hash, usageUsd);
    },

    setDisabled(hash, disabled) {
      const entry = keys.get(hash);
      if (entry === undefined) {
        throw new OpenRouterApiError(`API key not found: ${hash}`, { statusCode: 404 });
      }
      entry.info = { ...entry.info, disabled };
    },

    fail(operation, error) {
      failures.set(operation, error);
    },
  };
}
