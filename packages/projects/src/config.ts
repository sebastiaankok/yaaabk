import type { PolicyRule } from '@yaaabk/k8s';

/** Namespace agent Jobs, PVCs and agent Secrets are provisioned in. */
export const AGENT_NAMESPACE = 'yaaabk';

/**
 * Namespace every Project's ArgoCD Application is created in.
 *
 * The same namespace the backend and the agent Jobs run in, so ArgoCD has to
 * watch exactly one namespace for Applications and the backend needs exactly
 * one RoleBinding for them. A Project's workloads still land in its own
 * `yaaabk-<id>` namespace — this is where the Application *resource* lives,
 * not what it deploys.
 */
export const ARGOCD_APPLICATION_NAMESPACE = 'yaaabk';

/** Shared AppProject every Project Application defers to, managed via GitOps. */
export const ARGOCD_APP_PROJECT_NAME = 'yaaabk';

/** ServiceAccount the Project's agent Jobs run as. */
export const PROJECT_AGENT_SERVICE_ACCOUNT = 'yaaabk-agent';

/** ServiceAccount the Project's deploy Jobs run as. */
export const PROJECT_DEPLOY_SERVICE_ACCOUNT = 'yaaabk-deploy';

/**
 * RBAC rules for `yaaabk-agent`: read-only (get/list/watch) on core resources,
 * deployments, and httproutes, plus create on pods/exec. Never grants secrets
 * read.
 */
export const PROJECT_AGENT_ROLE_RULES: PolicyRule[] = [
  {
    apiGroups: [''],
    resources: ['pods', 'pods/log', 'services', 'configmaps', 'events'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['apps'],
    resources: ['deployments'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['gateway.networking.k8s.io'],
    resources: ['httproutes'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: [''],
    resources: ['pods/exec'],
    verbs: ['create'],
  },
];

/**
 * RBAC rules for `yaaabk-deploy`: full write on deployments, services,
 * configmaps, secrets, and httproutes, plus read on pods/pods/log. Cannot
 * create or delete namespaces.
 */
export const PROJECT_DEPLOY_ROLE_RULES: PolicyRule[] = [
  {
    apiGroups: [''],
    resources: ['services', 'configmaps', 'secrets'],
    verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
  },
  {
    apiGroups: ['apps'],
    resources: ['deployments'],
    verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
  },
  {
    apiGroups: ['gateway.networking.k8s.io'],
    resources: ['httproutes'],
    verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
  },
  {
    apiGroups: [''],
    resources: ['pods', 'pods/log'],
    verbs: ['get', 'list'],
  },
];

/**
 * Key the GitHub token is stored under in that Secret.
 *
 * Matches the environment variable name so an agent Job can load the whole
 * Secret with `envFrom` rather than YAAABK reading the value.
 */
export const GITHUB_TOKEN_KEY = 'GITHUB_TOKEN';

/** Label tying a namespace back to its Project by human-readable name. */
export const PROJECT_NAME_LABEL = 'yaaabk.io/project-name';

/**
 * Pod Security Admission labels enforcing the `restricted` standard on every
 * Project namespace: pods must run as non-root with a dropped capability set.
 *
 * `enforce` rejects violating pods; `audit` and `warn` record and surface
 * violations without blocking, so Platform Admins can see what a future
 * enforcement bump would reject.
 */
export const PROJECT_PSA_LABELS: Record<string, string> = {
  'pod-security.kubernetes.io/enforce': 'restricted',
  'pod-security.kubernetes.io/enforce-version': 'latest',
  'pod-security.kubernetes.io/audit': 'restricted',
  'pod-security.kubernetes.io/warn': 'restricted',
};

/** Path within a Project repository ArgoCD syncs from. */
export const ARGO_SOURCE_PATH = 'deploy';

/** ArgoCD destination server; the in-cluster API server. */
export const ARGO_DESTINATION_SERVER = 'https://kubernetes.default.svc';

/** Branch the scaffold pushes to and ArgoCD tracks. */
export const DEFAULT_BRANCH = 'main';

/**
 * Namespaced resource kinds a Project's ArgoCD Application may manage: exactly
 * what the Svelte+Bun template deploys. Enforced by the per-Project AppProject,
 * so an Application in a Project namespace cannot create other kinds.
 */
export const ARGO_NAMESPACE_RESOURCES = [
  { group: 'apps', kind: 'Deployment' },
  { group: '', kind: 'Service' },
  { group: 'networking.k8s.io', kind: 'Ingress' },
  { group: '', kind: 'ConfigMap' },
  { group: '', kind: 'Secret' },
];

// Longest Project description, a field constraint shared with the frontend.
export { MAX_DESCRIPTION_LENGTH } from '@yaaabk/shared';
