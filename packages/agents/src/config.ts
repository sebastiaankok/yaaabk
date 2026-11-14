/** Default cap on Agents running for one Project at a time. */
export const DEFAULT_MAX_CONCURRENT_PER_PROJECT = 2;

/** Default cap on Agents running across the whole cluster. */
export const DEFAULT_MAX_CONCURRENT_CLUSTER = 10;

/** Default working-volume size requested for an attempt. */
export const DEFAULT_PVC_STORAGE = '1Gi';

/** Default agent container image. Pinned (never `latest`) for policy compliance. */
export const DEFAULT_AGENT_IMAGE = 'yaaabk/agent:0.1.0';

/** Default seconds an attempt may run before Kubernetes kills its pod. */
export const DEFAULT_ACTIVE_DEADLINE_SECONDS = 30 * 60;

/** Path the attempt's working PVC is mounted at inside the container. */
export const WORKSPACE_MOUNT_PATH = '/work';

/** Name of the volume and mount backing the working PVC. */
export const WORKSPACE_VOLUME_NAME = 'work';

/** Key the OpenRouter key is stored under in a per-attempt Secret. */
export const OPENROUTER_SECRET_KEY = 'OPENROUTER_API_KEY';

/** The Job name for an Issue's attempt. */
export function jobName(issueId: string, attempt: number): string {
  return `agent-${issueId}-attempt-${attempt}`;
}

/** The working PVC name for an Issue's attempt, retained after the Job ends. */
export function pvcName(issueId: string, attempt: number): string {
  return `agent-work-${issueId}-${attempt}`;
}

/** The per-attempt Secret name holding the OpenRouter key, when one is used. */
export function openrouterSecretName(issueId: string, attempt: number): string {
  return `agent-openrouter-${issueId}-${attempt}`;
}
