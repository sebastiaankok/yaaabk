import { apiError } from './errors';
import type { K8sObject, K8sObjectRef, ListOptions, ObjectApi } from './object-api';

/** Deep-copies a plain object so callers cannot mutate the store. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function keyOf(ref: K8sObjectRef): string {
  return [ref.apiVersion, ref.kind, ref.metadata.namespace ?? '', ref.metadata.name].join('/');
}

function labelsMatch(object: K8sObject, labels?: Record<string, string>): boolean {
  if (labels === undefined) {
    return true;
  }
  const actual = object.metadata.labels ?? {};
  return Object.entries(labels).every(([key, value]) => actual[key] === value);
}

function merge(existing: K8sObject, patch: K8sObject): K8sObject {
  const metadata = {
    ...existing.metadata,
    ...patch.metadata,
    labels: { ...existing.metadata.labels, ...patch.metadata.labels },
  };
  return { ...existing, ...patch, metadata };
}

/**
 * An in-memory {@link ObjectApi} used for tests and by {@link createMockK8sClient}.
 *
 * It mimics the API server's observable behaviour: create conflicts on an
 * existing name, reads and deletes 404 on a missing one, and list filters by
 * namespace and labels. Failures carry an HTTP status code so the client maps
 * them to the same typed errors as a real cluster.
 */
export function createInMemoryObjectApi(seed: K8sObject[] = []): ObjectApi {
  const store = new Map<string, K8sObject>();
  const watchers = new Map<string, Set<(object: K8sObject) => void>>();
  for (const object of seed) {
    store.set(keyOf(object), clone(object));
  }

  function notify(object: K8sObject): void {
    for (const listener of watchers.get(keyOf(object)) ?? []) {
      listener(clone(object));
    }
  }

  return {
    async create(spec) {
      const key = keyOf(spec);
      if (store.has(key)) {
        throw apiError(409, `${spec.kind} ${spec.metadata.name} already exists`);
      }
      store.set(key, clone(spec));
      notify(spec);
      return clone(spec);
    },

    async read(ref) {
      const found = store.get(keyOf(ref));
      if (found === undefined) {
        throw apiError(404, `${ref.kind} ${ref.metadata.name} not found`);
      }
      return clone(found);
    },

    async list(apiVersion, kind, options: ListOptions = {}) {
      return [...store.values()]
        .filter((object) => object.apiVersion === apiVersion && object.kind === kind)
        .filter(
          (object) =>
            options.namespace === undefined || object.metadata.namespace === options.namespace,
        )
        .filter((object) => labelsMatch(object, options.labels))
        .map(clone);
    },

    async patch(spec) {
      const key = keyOf(spec);
      const existing = store.get(key);
      if (existing === undefined) {
        throw apiError(404, `${spec.kind} ${spec.metadata.name} not found`);
      }
      const merged = merge(existing, spec);
      store.set(key, clone(merged));
      notify(merged);
      return clone(merged);
    },

    async delete(ref) {
      const key = keyOf(ref);
      if (!store.has(key)) {
        throw apiError(404, `${ref.kind} ${ref.metadata.name} not found`);
      }
      store.delete(key);
    },

    async watch(ref, onEvent) {
      const key = keyOf(ref);
      const listeners = watchers.get(key) ?? new Set<(object: K8sObject) => void>();
      listeners.add(onEvent);
      watchers.set(key, listeners);
      return () => {
        listeners.delete(onEvent);
      };
    },
  };
}
