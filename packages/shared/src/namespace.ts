/** Prefix applied to every Kubernetes namespace that hosts a Project. */
export const PROJECT_NAMESPACE_PREFIX = 'project-';

/** Number of hex characters taken from a Project id to form a namespace suffix. */
const SHORT_ID_LENGTH = 8;

/**
 * Derives the Kubernetes namespace for a Project from its internal id.
 *
 * The namespace is `project-<short-uuid>`, where the short uuid is the first
 * eight hex characters of the id with separators removed.
 */
export function projectNamespace(projectId: string): string {
  const compact = projectId.replace(/-/g, '');
  if (compact.length < SHORT_ID_LENGTH) {
    throw new Error('Project id must contain at least 8 characters to derive a namespace');
  }
  return `${PROJECT_NAMESPACE_PREFIX}${compact.slice(0, SHORT_ID_LENGTH)}`;
}
