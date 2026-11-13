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

export interface ObjectApi {
  create(spec: K8sObject): Promise<K8sObject>;
  read(ref: K8sObjectRef): Promise<K8sObject>;
  list(apiVersion: string, kind: string, options?: ListOptions): Promise<K8sObject[]>;
  patch(spec: K8sObject): Promise<K8sObject>;
  delete(ref: K8sObjectRef): Promise<void>;
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
  roleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding' },
  job: { apiVersion: 'batch/v1', kind: 'Job' },
  pvc: { apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
  application: { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application' },
} as const;
