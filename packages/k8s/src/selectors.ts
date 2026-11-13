/** Serialises a label map into a Kubernetes label selector. */
export function labelSelector(labels?: Record<string, string>): string | undefined {
  if (labels === undefined) {
    return undefined;
  }
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(',');
}

/** Plural resource names for the kinds YAAABK manages. */
const PLURALS: Record<string, string> = {
  Namespace: 'namespaces',
  Secret: 'secrets',
  ServiceAccount: 'serviceaccounts',
  RoleBinding: 'rolebindings',
  Job: 'jobs',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  Application: 'applications',
};

const CLUSTER_SCOPED = new Set(['Namespace']);

/**
 * Builds the REST path for a resource collection, used for watching.
 *
 * `@kubernetes/client-node`'s object API discovers this path itself, but the
 * `Watch` helper needs it up front.
 */
export function resourcePath(apiVersion: string, kind: string, namespace?: string): string {
  const plural = PLURALS[kind] ?? `${kind.toLowerCase()}s`;
  const slash = apiVersion.indexOf('/');
  const base = slash === -1 ? `/api/${apiVersion}` : `/apis/${apiVersion}`;
  if (namespace === undefined || CLUSTER_SCOPED.has(kind)) {
    return `${base}/${plural}`;
  }
  return `${base}/namespaces/${namespace}/${plural}`;
}
