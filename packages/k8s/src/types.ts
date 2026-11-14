/**
 * Public domain types for the K8s Client Module.
 *
 * The module never exposes raw Kubernetes objects: every operation returns one
 * of the summaries below, so callers stay decoupled from the upstream
 * `@kubernetes/client-node` types.
 */

/** The kinds of failure a K8s operation can report. */
export type K8sErrorKind =
  'not-found' | 'forbidden' | 'conflict' | 'invalid' | 'network' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface K8sError {
  kind: K8sErrorKind;
  /** The operation that failed, e.g. `namespaces.create`. */
  operation: string;
  message: string;
  /** HTTP status from the API server, when the failure came from a response. */
  statusCode?: number;
}

/** The result of a K8s operation: either a value or a typed error. */
export type K8sResult<T> = { ok: true; value: T } | { ok: false; error: K8sError };

/** Fields shared by every resource summary. */
export interface ResourceMeta {
  name: string;
  /** Absent for cluster-scoped resources such as Namespaces. */
  namespace?: string;
  labels: Record<string, string>;
}

export interface NamespaceInfo extends ResourceMeta {
  /** `Active` or `Terminating`. */
  phase: string;
}

/** A Secret summary. Never carries secret values, only the keys present. */
export interface SecretInfo extends ResourceMeta {
  keys: string[];
}

export type ServiceAccountInfo = ResourceMeta;

export interface RoleRef {
  apiGroup: string;
  kind: string;
  name: string;
}

export interface Subject {
  kind: string;
  name: string;
  namespace?: string;
}

export interface RoleBindingInfo extends ResourceMeta {
  roleRef: RoleRef;
  subjects: Subject[];
}

/** Coarse Job lifecycle state, collapsed from Kubernetes' condition list. */
export type JobPhase = 'pending' | 'running' | 'succeeded' | 'failed';

export interface JobInfo extends ResourceMeta {
  phase: JobPhase;
  active: number;
  succeeded: number;
  failed: number;
}

export interface PvcInfo extends ResourceMeta {
  phase: string;
  /** Requested storage, e.g. `1Gi`. */
  storage: string;
}

export interface ApplicationInfo extends ResourceMeta {
  syncStatus: string;
  healthStatus: string;
}

/** A named volume a Job mounts into its container. */
export interface JobVolume {
  name: string;
  persistentVolumeClaim: { claimName: string };
}

/** A mount of a {@link JobVolume} at a path inside the container. */
export interface JobVolumeMount {
  name: string;
  mountPath: string;
}

/** Specification for a per-issue agent Job. */
export interface JobSpec {
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  /**
   * Secrets whose keys are exposed as environment variables. YAAABK references
   * the Secret by name; it never reads the values itself.
   */
  envFrom?: Array<{ secretRef: { name: string } }>;
  serviceAccountName?: string;
  restartPolicy?: 'Never' | 'OnFailure';
  backoffLimit?: number;
  /** Seconds a Job may run before Kubernetes kills its pod. */
  activeDeadlineSeconds?: number;
  volumes?: JobVolume[];
  volumeMounts?: JobVolumeMount[];
  labels?: Record<string, string>;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
}

export interface PvcSpec {
  storage: string;
  /** Defaults to `['ReadWriteOnce']`. */
  accessModes?: string[];
  storageClassName?: string;
  labels?: Record<string, string>;
}

/** Specification for an ArgoCD `Application` custom resource. */
export interface ApplicationSpec {
  project?: string;
  source: {
    repoURL: string;
    path: string;
    targetRevision?: string;
  };
  destination: {
    server?: string;
    namespace: string;
  };
  syncPolicy?: {
    automated?: {
      prune?: boolean;
      selfHeal?: boolean;
    };
  };
  labels?: Record<string, string>;
}

/**
 * The K8s Client Module's public contract.
 *
 * Every method resolves to a {@link K8sResult}; callers branch on `ok` instead
 * of catching exceptions.
 */
export interface K8sClient {
  namespaces: {
    create(
      name: string,
      options?: { labels?: Record<string, string> },
    ): Promise<K8sResult<NamespaceInfo>>;
    get(name: string): Promise<K8sResult<NamespaceInfo>>;
    list(labels?: Record<string, string>): Promise<K8sResult<NamespaceInfo[]>>;
    label(name: string, labels: Record<string, string>): Promise<K8sResult<NamespaceInfo>>;
    delete(name: string): Promise<K8sResult<void>>;
  };
  secrets: {
    create(
      namespace: string,
      name: string,
      data: Record<string, string>,
    ): Promise<K8sResult<SecretInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<SecretInfo>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
  serviceAccounts: {
    create(namespace: string, name: string): Promise<K8sResult<ServiceAccountInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<ServiceAccountInfo>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
  roleBindings: {
    create(
      namespace: string,
      name: string,
      binding: { roleRef: RoleRef; subjects: Subject[] },
    ): Promise<K8sResult<RoleBindingInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<RoleBindingInfo>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
  jobs: {
    create(namespace: string, name: string, spec: JobSpec): Promise<K8sResult<JobInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<JobInfo>>;
    list(namespace: string, labels?: Record<string, string>): Promise<K8sResult<JobInfo[]>>;
    /**
     * Streams Job status updates until the Job reaches a terminal phase or the
     * returned unsubscribe function is called.
     */
    watch(
      namespace: string,
      name: string,
      handler: (job: JobInfo) => void,
    ): Promise<K8sResult<() => void>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
  pvcs: {
    create(namespace: string, name: string, spec: PvcSpec): Promise<K8sResult<PvcInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<PvcInfo>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
  applications: {
    create(
      namespace: string,
      name: string,
      spec: ApplicationSpec,
    ): Promise<K8sResult<ApplicationInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<ApplicationInfo>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
}
