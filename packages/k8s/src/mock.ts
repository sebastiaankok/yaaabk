import { createK8sClient, type K8sClientOptions } from './client';
import { silentLogger } from './errors';
import { createInMemoryObjectApi } from './in-memory-object-api';
import type { K8sObject, ObjectApi } from './object-api';
import type { K8sClient } from './types';

export interface MockK8sClientOptions {
  /** Objects the fake cluster starts with, as if they already existed. */
  seed?: K8sObject[];
  logger?: K8sClientOptions['logger'];
}

/** A {@link K8sClient} backed by an in-memory store, for testing other modules. */
export interface MockK8sClient extends K8sClient {
  /** The in-memory backend, exposed so tests can arrange cluster state. */
  readonly objectApi: ObjectApi;
}

/**
 * Builds a K8s Client backed by an in-memory cluster.
 *
 * Other modules (Projects, Agent Manager) can depend on this in their unit
 * tests instead of mocking the client method by method: it behaves like a real
 * API server for the operations YAAABK uses, including conflict and not-found
 * responses.
 */
export function createMockK8sClient(options: MockK8sClientOptions = {}): MockK8sClient {
  const objectApi = createInMemoryObjectApi(options.seed ?? []);
  return {
    ...createK8sClient({ objectApi, logger: options.logger ?? silentLogger }),
    objectApi,
  };
}
