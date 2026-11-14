import type { K8sConnectionConfig } from './config';
import { consoleLogger, toK8sError, type K8sLogger } from './errors';
import { createKubernetesObjectApi } from './kubernetes-adapter';
import { KINDS, type K8sObject, type ObjectApi } from './object-api';
import type {
  ApplicationInfo,
  JobInfo,
  JobPhase,
  JobSpec,
  K8sClient,
  K8sResult,
  NamespaceInfo,
  PvcInfo,
  RoleBindingInfo,
  SecretInfo,
  ServiceAccountInfo,
} from './types';

export interface K8sClientOptions {
  /**
   * Low-level port the client is built on. Tests inject an in-memory
   * implementation; when omitted the client talks to a real cluster.
   */
  objectApi?: ObjectApi;
  /** Overrides in-cluster/kubeconfig auto-detection for the real adapter. */
  connection?: K8sConnectionConfig;
  /** Log intended operations and skip every call to the cluster. */
  dryRun?: boolean;
  logger?: K8sLogger;
}

function labelsOf(metadata: K8sObject['metadata']): Record<string, string> {
  return { ...(metadata.labels ?? {}) };
}

/** Kubernetes stores Secret values base64-encoded under `data`. */
function encodeSecretData(data: Record<string, string>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    encoded[key] = Buffer.from(value, 'utf8').toString('base64');
  }
  return encoded;
}

function stringField(object: K8sObject, path: readonly string[]): string | undefined {
  let current: unknown = object;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function numberField(object: K8sObject, path: readonly string[]): number {
  let current: unknown = object;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return 0;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'number' ? current : 0;
}

function toNamespaceInfo(object: K8sObject): NamespaceInfo {
  return {
    name: object.metadata.name,
    labels: labelsOf(object.metadata),
    phase: stringField(object, ['status', 'phase']) ?? 'Active',
  };
}

function toSecretInfo(object: K8sObject): SecretInfo {
  const data = object.data;
  const keys =
    typeof data === 'object' && data !== null
      ? Object.keys(data as Record<string, unknown>).sort()
      : [];
  return {
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    labels: labelsOf(object.metadata),
    keys,
  };
}

function toServiceAccountInfo(object: K8sObject): ServiceAccountInfo {
  return {
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    labels: labelsOf(object.metadata),
  };
}

function toRoleBindingInfo(object: K8sObject): RoleBindingInfo {
  const roleRef = (object.roleRef ?? {}) as RoleBindingInfo['roleRef'];
  const subjects = Array.isArray(object.subjects)
    ? (object.subjects as RoleBindingInfo['subjects'])
    : [];
  return {
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    labels: labelsOf(object.metadata),
    roleRef,
    subjects,
  };
}

function toJobPhase(object: K8sObject): JobPhase {
  const conditions = (
    object.status as { conditions?: Array<{ type?: string; status?: string }> } | undefined
  )?.conditions;
  if (Array.isArray(conditions)) {
    for (const condition of conditions) {
      if (condition.type === 'Complete' && condition.status === 'True') {
        return 'succeeded';
      }
      if (condition.type === 'Failed' && condition.status === 'True') {
        return 'failed';
      }
    }
  }
  return numberField(object, ['status', 'active']) > 0 ? 'running' : 'pending';
}

function toJobInfo(object: K8sObject): JobInfo {
  return {
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    labels: labelsOf(object.metadata),
    phase: toJobPhase(object),
    active: numberField(object, ['status', 'active']),
    succeeded: numberField(object, ['status', 'succeeded']),
    failed: numberField(object, ['status', 'failed']),
  };
}

function toPvcInfo(object: K8sObject): PvcInfo {
  return {
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    labels: labelsOf(object.metadata),
    phase: stringField(object, ['status', 'phase']) ?? 'Pending',
    storage: stringField(object, ['spec', 'resources', 'requests', 'storage']) ?? '',
  };
}

function toApplicationInfo(object: K8sObject): ApplicationInfo {
  return {
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    labels: labelsOf(object.metadata),
    syncStatus: stringField(object, ['status', 'sync', 'status']) ?? 'Unknown',
    healthStatus: stringField(object, ['status', 'health', 'status']) ?? 'Unknown',
  };
}

/** Builds the Job manifest for a single agent attempt. */
function jobManifest(namespace: string, name: string, spec: JobSpec): K8sObject {
  const container: Record<string, unknown> = { name: 'agent', image: spec.image };
  if (spec.command !== undefined) {
    container.command = spec.command;
  }
  if (spec.args !== undefined) {
    container.args = spec.args;
  }
  if (spec.env !== undefined) {
    container.env = Object.entries(spec.env).map(([envName, value]) => ({ name: envName, value }));
  }
  if (spec.envFrom !== undefined) {
    container.envFrom = spec.envFrom;
  }
  if (spec.volumeMounts !== undefined) {
    container.volumeMounts = spec.volumeMounts;
  }
  if (spec.resources !== undefined) {
    container.resources = spec.resources;
  }

  const podSpec: Record<string, unknown> = {
    restartPolicy: spec.restartPolicy ?? 'Never',
    containers: [container],
  };
  if (spec.serviceAccountName !== undefined) {
    podSpec.serviceAccountName = spec.serviceAccountName;
  }
  if (spec.volumes !== undefined) {
    podSpec.volumes = spec.volumes;
  }

  const jobSpec: Record<string, unknown> = {
    backoffLimit: spec.backoffLimit ?? 1,
    template: { spec: podSpec },
  };
  if (spec.activeDeadlineSeconds !== undefined) {
    jobSpec.activeDeadlineSeconds = spec.activeDeadlineSeconds;
  }

  return {
    ...KINDS.job,
    metadata: { name, namespace, labels: spec.labels ?? {} },
    spec: jobSpec,
  };
}

/** Builds the public client. */
export function createK8sClient(options: K8sClientOptions = {}): K8sClient {
  const logger = options.logger ?? consoleLogger;
  const dryRun = options.dryRun ?? false;
  let clusterApi: ObjectApi | undefined = options.objectApi;

  function objectApi(): ObjectApi {
    if (clusterApi === undefined) {
      clusterApi = createKubernetesObjectApi({ connection: options.connection });
    }
    return clusterApi;
  }

  /**
   * Runs an operation, mapping failures to typed errors and logging every
   * attempt for auditability. In dry-run mode callers return a synthetic value
   * without ever reaching the cluster, and the same log line records the intent.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<K8sResult<T>> {
    try {
      const value = await run();
      logger.info(`k8s ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toK8sError(operation, error);
      logger.error(`k8s ${operation} failed`, {
        ...fields,
        kind: mapped.kind,
        statusCode: mapped.statusCode,
      });
      return { ok: false, error: mapped };
    }
  }

  return {
    namespaces: {
      create: (name, createOptions) => {
        const labels = createOptions?.labels ?? {};
        return guard('namespaces.create', { name, labels }, async () => {
          if (dryRun) {
            return { name, labels, phase: 'Active' } satisfies NamespaceInfo;
          }
          return toNamespaceInfo(
            await objectApi().create({ ...KINDS.namespace, metadata: { name, labels } }),
          );
        });
      },
      get: (name) =>
        guard('namespaces.get', { name }, async () => {
          if (dryRun) {
            return { name, labels: {}, phase: 'Active' } satisfies NamespaceInfo;
          }
          return toNamespaceInfo(
            await objectApi().read({ ...KINDS.namespace, metadata: { name } }),
          );
        }),
      list: (labels) =>
        guard('namespaces.list', { labels }, async () => {
          if (dryRun) {
            return [] satisfies NamespaceInfo[];
          }
          const objects = await objectApi().list(KINDS.namespace.apiVersion, KINDS.namespace.kind, {
            labels,
          });
          return objects.map(toNamespaceInfo);
        }),
      label: (name, labels) =>
        guard('namespaces.label', { name, labels }, async () => {
          if (dryRun) {
            return { name, labels, phase: 'Active' } satisfies NamespaceInfo;
          }
          return toNamespaceInfo(
            await objectApi().patch({ ...KINDS.namespace, metadata: { name, labels } }),
          );
        }),
      delete: (name) =>
        guard('namespaces.delete', { name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.namespace, metadata: { name } });
          return undefined;
        }),
    },
    secrets: {
      create: (namespace, name, data) =>
        guard('secrets.create', { namespace, name, keys: Object.keys(data).sort() }, async () => {
          if (dryRun) {
            return {
              name,
              namespace,
              labels: {},
              keys: Object.keys(data).sort(),
            } satisfies SecretInfo;
          }
          return toSecretInfo(
            await objectApi().create({
              ...KINDS.secret,
              metadata: { name, namespace },
              data: encodeSecretData(data),
            }),
          );
        }),
      get: (namespace, name) =>
        guard('secrets.get', { namespace, name }, async () => {
          if (dryRun) {
            return { name, namespace, labels: {}, keys: [] } satisfies SecretInfo;
          }
          return toSecretInfo(
            await objectApi().read({ ...KINDS.secret, metadata: { name, namespace } }),
          );
        }),
      delete: (namespace, name) =>
        guard('secrets.delete', { namespace, name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.secret, metadata: { name, namespace } });
          return undefined;
        }),
    },
    serviceAccounts: {
      create: (namespace, name) =>
        guard('serviceAccounts.create', { namespace, name }, async () => {
          if (dryRun) {
            return { name, namespace, labels: {} } satisfies ServiceAccountInfo;
          }
          return toServiceAccountInfo(
            await objectApi().create({ ...KINDS.serviceAccount, metadata: { name, namespace } }),
          );
        }),
      get: (namespace, name) =>
        guard('serviceAccounts.get', { namespace, name }, async () => {
          if (dryRun) {
            return { name, namespace, labels: {} } satisfies ServiceAccountInfo;
          }
          return toServiceAccountInfo(
            await objectApi().read({ ...KINDS.serviceAccount, metadata: { name, namespace } }),
          );
        }),
      delete: (namespace, name) =>
        guard('serviceAccounts.delete', { namespace, name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.serviceAccount, metadata: { name, namespace } });
          return undefined;
        }),
    },
    roleBindings: {
      create: (namespace, name, binding) =>
        guard('roleBindings.create', { namespace, name, ...binding }, async () => {
          if (dryRun) {
            return { name, namespace, labels: {}, ...binding } satisfies RoleBindingInfo;
          }
          return toRoleBindingInfo(
            await objectApi().create({
              ...KINDS.roleBinding,
              metadata: { name, namespace },
              roleRef: binding.roleRef,
              subjects: binding.subjects,
            }),
          );
        }),
      get: (namespace, name) =>
        guard('roleBindings.get', { namespace, name }, async () => {
          if (dryRun) {
            return {
              name,
              namespace,
              labels: {},
              roleRef: { apiGroup: '', kind: '', name: '' },
              subjects: [],
            } satisfies RoleBindingInfo;
          }
          return toRoleBindingInfo(
            await objectApi().read({ ...KINDS.roleBinding, metadata: { name, namespace } }),
          );
        }),
      delete: (namespace, name) =>
        guard('roleBindings.delete', { namespace, name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.roleBinding, metadata: { name, namespace } });
          return undefined;
        }),
    },
    jobs: {
      create: (namespace, name, spec) =>
        guard('jobs.create', { namespace, name, image: spec.image }, async () => {
          if (dryRun) {
            return {
              name,
              namespace,
              labels: spec.labels ?? {},
              phase: 'pending',
              active: 0,
              succeeded: 0,
              failed: 0,
            } satisfies JobInfo;
          }
          return toJobInfo(await objectApi().create(jobManifest(namespace, name, spec)));
        }),
      get: (namespace, name) =>
        guard('jobs.get', { namespace, name }, async () => {
          if (dryRun) {
            return {
              name,
              namespace,
              labels: {},
              phase: 'pending',
              active: 0,
              succeeded: 0,
              failed: 0,
            } satisfies JobInfo;
          }
          return toJobInfo(await objectApi().read({ ...KINDS.job, metadata: { name, namespace } }));
        }),
      list: (namespace, labels) =>
        guard('jobs.list', { namespace, labels }, async () => {
          if (dryRun) {
            return [] satisfies JobInfo[];
          }
          const objects = await objectApi().list(KINDS.job.apiVersion, KINDS.job.kind, {
            namespace,
            labels,
          });
          return objects.map(toJobInfo);
        }),
      watch: (namespace, name, handler) =>
        guard('jobs.watch', { namespace, name }, async () => {
          if (dryRun) {
            return () => {};
          }
          let terminal = false;
          const control: { stop?: () => void } = {};
          const stop = await objectApi().watch(
            { ...KINDS.job, metadata: { name, namespace } },
            (object) => {
              const info = toJobInfo(object);
              handler(info);
              if (info.phase === 'succeeded' || info.phase === 'failed') {
                terminal = true;
                control.stop?.();
              }
            },
          );
          control.stop = stop;
          if (terminal) {
            stop();
          }
          return stop;
        }),
      delete: (namespace, name) =>
        guard('jobs.delete', { namespace, name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.job, metadata: { name, namespace } });
          return undefined;
        }),
    },
    pvcs: {
      create: (namespace, name, spec) =>
        guard('pvcs.create', { namespace, name, storage: spec.storage }, async () => {
          const accessModes = spec.accessModes ?? ['ReadWriteOnce'];
          if (dryRun) {
            return {
              name,
              namespace,
              labels: spec.labels ?? {},
              phase: 'Pending',
              storage: spec.storage,
            } satisfies PvcInfo;
          }
          const manifest: K8sObject = {
            ...KINDS.pvc,
            metadata: { name, namespace, labels: spec.labels ?? {} },
            spec: {
              accessModes,
              resources: { requests: { storage: spec.storage } },
            },
          };
          if (spec.storageClassName !== undefined) {
            (manifest.spec as Record<string, unknown>).storageClassName = spec.storageClassName;
          }
          return toPvcInfo(await objectApi().create(manifest));
        }),
      get: (namespace, name) =>
        guard('pvcs.get', { namespace, name }, async () => {
          if (dryRun) {
            return { name, namespace, labels: {}, phase: 'Pending', storage: '' } satisfies PvcInfo;
          }
          return toPvcInfo(await objectApi().read({ ...KINDS.pvc, metadata: { name, namespace } }));
        }),
      delete: (namespace, name) =>
        guard('pvcs.delete', { namespace, name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.pvc, metadata: { name, namespace } });
          return undefined;
        }),
    },
    applications: {
      create: (namespace, name, spec) =>
        guard('applications.create', { namespace, name }, async () => {
          if (dryRun) {
            return {
              name,
              namespace,
              labels: spec.labels ?? {},
              syncStatus: 'Unknown',
              healthStatus: 'Unknown',
            } satisfies ApplicationInfo;
          }
          return toApplicationInfo(
            await objectApi().create({
              ...KINDS.application,
              metadata: { name, namespace, labels: spec.labels ?? {} },
              spec: {
                project: spec.project ?? 'default',
                source: spec.source,
                destination: spec.destination,
                ...(spec.syncPolicy !== undefined ? { syncPolicy: spec.syncPolicy } : {}),
              },
            }),
          );
        }),
      get: (namespace, name) =>
        guard('applications.get', { namespace, name }, async () => {
          if (dryRun) {
            return {
              name,
              namespace,
              labels: {},
              syncStatus: 'Unknown',
              healthStatus: 'Unknown',
            } satisfies ApplicationInfo;
          }
          return toApplicationInfo(
            await objectApi().read({ ...KINDS.application, metadata: { name, namespace } }),
          );
        }),
      delete: (namespace, name) =>
        guard('applications.delete', { namespace, name }, async () => {
          if (dryRun) {
            return undefined;
          }
          await objectApi().delete({ ...KINDS.application, metadata: { name, namespace } });
          return undefined;
        }),
    },
  };
}
