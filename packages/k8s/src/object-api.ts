/**
 * The low-level port the {@link K8sClient} is built on.
 *
 * It is intentionally generic (any `apiVersion`/`kind`) and narrow (five
 * verbs), so the high-level module holds all the YAAABK-specific logic while
 * the adapter holds all the `@kubernetes/client-node` specifics. Tests inject
 * an in-memory implementation instead of talking to a cluster.
 */

/** A raw Kubernetes object. Only the fields the module relies on are typed. */
export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Identifies a single object for reads and deletes. */
export interface K8sObjectRef {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
}

export interface ListOptions {
  namespace?: string;
  labels?: Record<string, string>;
}

/** How much of a container's output to read, and whether to keep following it. */
export interface LogOptions {
  /** Keep the connection open and emit output as it is written. */
  follow?: boolean;
  /** Newest N lines to start from; omit for the whole log. */
  tailLines?: number;
  /** Container to read from; omit for a single-container Pod. */
  container?: string;
}

export interface ObjectApi {
  create(spec: K8sObject): Promise<K8sObject>;
  read(ref: K8sObjectRef): Promise<K8sObject>;
  list(apiVersion: string, kind: string, options?: ListOptions): Promise<K8sObject[]>;
  patch(spec: K8sObject): Promise<K8sObject>;
  delete(ref: K8sObjectRef): Promise<void>;
  /**
   * Streams a Pod container's log. Closes when the container ends when
   * `follow` is set, so a caller can treat stream end as "no more output".
   */
  logs(ref: K8sObjectRef, options?: LogOptions): Promise<ReadableStream<Uint8Array>>;
  /**
   * Subscribes to updates for a single object. Resolves to an unsubscribe
   * function. The adapter may deliver a synthetic initial event.
   */
  watch(ref: K8sObjectRef, onEvent: (object: K8sObject) => void): Promise<() => void>;
}

/** Kinds the module manages, with their API versions. */
export const KINDS = {
  namespace: { apiVersion: 'v1', kind: 'Namespace' },
  secret: { apiVersion: 'v1', kind: 'Secret' },
  serviceAccount: { apiVersion: 'v1', kind: 'ServiceAccount' },
  role: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role' },
  roleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding' },
  job: { apiVersion: 'batch/v1', kind: 'Job' },
  pvc: { apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
  pod: { apiVersion: 'v1', kind: 'Pod' },
  networkPolicy: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
} as const;
