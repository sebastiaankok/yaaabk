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

/** Key the GitHub token is stored under in that Secret. */
export const GITHUB_TOKEN_KEY = 'token';

/** Label tying a namespace back to its Project by human-readable name. */
export const PROJECT_NAME_LABEL = 'yaaabk.io/project-name';

/** Path within a Project repository ArgoCD syncs from. */
export const ARGO_SOURCE_PATH = 'deploy';

/** ArgoCD destination server; the in-cluster API server. */
export const ARGO_DESTINATION_SERVER = 'https://kubernetes.default.svc';

/** Branch the scaffold pushes to and ArgoCD tracks. */
export const DEFAULT_BRANCH = 'main';

/** Longest Project description the module accepts. */
export const MAX_DESCRIPTION_LENGTH = 500;
