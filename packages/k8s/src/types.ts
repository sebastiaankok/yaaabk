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

/** A single RBAC policy rule granting verbs on resources within a Role. */
export interface PolicyRule {
  apiGroups: string[];
  resources: string[];
  resourceNames?: string[];
  verbs: string[];
  nonResourceURLs?: string[];
}

export interface RoleInfo extends ResourceMeta {
  rules: PolicyRule[];
}

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

/** A named volume a Job mounts into its container. */
export interface JobVolume {
  name: string;
  persistentVolumeClaim?: { claimName: string };
  /** Ephemeral working volume whose lifetime is the Pod's. */
  emptyDir?: Record<string, never>;
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
  /** Pod-level security context, e.g. `runAsNonRoot` and seccomp. */
  podSecurityContext?: Record<string, unknown>;
  /** Container-level security context, e.g. capabilities and privilege escalation. */
  containerSecurityContext?: Record<string, unknown>;
}

export interface PvcSpec {
  storage: string;
  /** Defaults to `['ReadWriteOnce']`. */
  accessModes?: string[];
  storageClassName?: string;
  labels?: Record<string, string>;
}

/** One container in a Pod, shared by the main and init containers. */
export interface PodContainerSpec {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  /** Working directory inside the container. */
  workingDir?: string;
  env?: Record<string, string>;
  /** Secrets whose keys are exposed as environment variables. */
  envFrom?: Array<{ secretRef: { name: string } }>;
  volumeMounts?: JobVolumeMount[];
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  securityContext?: Record<string, unknown>;
}

/** Specification for a session Pod. */
export interface PodSpec {
  containers: PodContainerSpec[];
  initContainers?: PodContainerSpec[];
  serviceAccountName?: string;
  restartPolicy?: 'Always' | 'OnFailure' | 'Never';
  volumes?: JobVolume[];
  labels?: Record<string, string>;
  /** Pod-level security context, e.g. `runAsNonRoot` and seccomp. */
  securityContext?: Record<string, unknown>;
}

/** Coarse Pod lifecycle state, collapsed from Kubernetes' phase. */
export type PodPhase = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';

export interface PodInfo extends ResourceMeta {
  phase: PodPhase;
  /** The Pod IP the backend proxy connects to, when assigned. */
  podIP: string | null;
  ready: boolean;
  /**
   * The first container waiting reason, e.g. `ErrImagePull: manifest unknown`.
   * Names the real cause when a session Pod cannot start.
   */
  waitingReason: string | null;
  /**
   * Why the first container last terminated, e.g. `OOMKilled` or `Error`.
   * Names the real cause when a Job fails without reporting anything.
   */
  terminationReason: string | null;
  /** The first container's exit code from its last termination, if any. */
  exitCode: number | null;
}

/** A single peer a NetworkPolicy allows traffic from or to. */
export interface NetworkPolicyPeer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
  ipBlock?: { cidr: string; except?: string[] };
}

/** A port a NetworkPolicy allows. */
export interface NetworkPolicyPort {
  protocol?: 'TCP' | 'UDP' | 'SCTP';
  port: number | string;
  endPort?: number;
}

export interface NetworkPolicyRule {
  from?: NetworkPolicyPeer[];
  to?: NetworkPolicyPeer[];
  ports?: NetworkPolicyPort[];
}

export interface NetworkPolicySpec {
  podSelector: { matchLabels?: Record<string, string> };
  policyTypes?: Array<'Ingress' | 'Egress'>;
  ingress?: NetworkPolicyRule[];
  egress?: NetworkPolicyRule[];
  /** Labels on the NetworkPolicy itself, for reconciliation listing. */
  labels?: Record<string, string>;
}

export interface NetworkPolicyInfo extends ResourceMeta {
  policyTypes: string[];
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
  roles: {
    create(namespace: string, name: string, rules: PolicyRule[]): Promise<K8sResult<RoleInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<RoleInfo>>;
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
  pods: {
    create(namespace: string, name: string, spec: PodSpec): Promise<K8sResult<PodInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<PodInfo>>;
    list(namespace: string, labels?: Record<string, string>): Promise<K8sResult<PodInfo[]>>;
    /**
     * Streams a Pod container's log. With `follow` the stream stays open until
     * the container exits, so a caller can proxy it to a browser as it runs.
     */
    logs(
      namespace: string,
      name: string,
      options?: { follow?: boolean; tailLines?: number; container?: string },
    ): Promise<K8sResult<ReadableStream<Uint8Array>>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
  networkPolicies: {
    create(
      namespace: string,
      name: string,
      spec: NetworkPolicySpec,
    ): Promise<K8sResult<NetworkPolicyInfo>>;
    get(namespace: string, name: string): Promise<K8sResult<NetworkPolicyInfo>>;
    list(
      namespace: string,
      labels?: Record<string, string>,
    ): Promise<K8sResult<NetworkPolicyInfo[]>>;
    delete(namespace: string, name: string): Promise<K8sResult<void>>;
  };
}
