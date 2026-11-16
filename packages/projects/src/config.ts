import type { PolicyRule } from '@yaaabk/k8s';

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

/** Path within a Project repository the deploy Job applies from. */
export const DEPLOY_SOURCE_PATH = 'deploy';

/** Branch the scaffold pushes to and the deploy Job deploys from. */
export const DEFAULT_BRANCH = 'main';

// Longest Project description, a field constraint shared with the frontend.
export { MAX_DESCRIPTION_LENGTH } from '@yaaabk/shared';
