import type { RoleRef } from '@yaaabk/k8s';

/** ServiceAccount the Project's agent Jobs run as. */
export const PROJECT_AGENT_SERVICE_ACCOUNT = 'yaaabk-agent';

/** RoleBinding granting that ServiceAccount its namespace-scoped access. */
export const PROJECT_AGENT_ROLE_BINDING = 'yaaabk-agent';

/** ClusterRole bound into each Project namespace, limiting the agent to it. */
export const PROJECT_AGENT_ROLE_REF: RoleRef = {
  apiGroup: 'rbac.authorization.k8s.io',
  kind: 'ClusterRole',
  name: 'edit',
};

/** Secret holding the GitHub token copied into each Project namespace. */
export const PROJECT_GITHUB_SECRET = 'yaaabk-github';

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
