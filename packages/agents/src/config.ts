import type { AgentRunKind } from './types';
import { DEFAULT_OPENCODE_MODEL } from '@yaaabk/shared';

/**
 * Model Agent Jobs invoke OpenCode with when the deployment configures none.
 * Shared with the session runtime so the two cannot drift.
 */
export const DEFAULT_AGENT_MODEL = DEFAULT_OPENCODE_MODEL;

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

/**
 * Pod-level security context every Agent Job runs with. Project Namespaces
 * enforce Pod Security `restricted`, and the agent image runs as the non-root
 * `bun` user (uid 1000), so these match a Session Pod rather than widening the
 * namespace policy.
 */
export const AGENT_POD_SECURITY_CONTEXT: Record<string, unknown> = {
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  fsGroup: 1000,
  seccompProfile: { type: 'RuntimeDefault' },
};

/** Container-level security context every Agent Job runs with. */
export const AGENT_CONTAINER_SECURITY_CONTEXT: Record<string, unknown> = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
};

/** Path the attempt's working PVC is mounted at inside the container. */
export const WORKSPACE_MOUNT_PATH = '/work';

/** Name of the volume and mount backing the working PVC. */
export const WORKSPACE_VOLUME_NAME = 'work';

/** Key the OpenRouter key is stored under in a per-attempt Secret. */
export const OPENROUTER_SECRET_KEY = 'OPENROUTER_API_KEY';

/** Key a run's GitHub token is stored under in its per-attempt Secret. */
export const GITHUB_TOKEN_SECRET_KEY = 'GITHUB_TOKEN';

/** Skill the implement-issue Job loads. */
export const IMPLEMENT_SKILL_PATH = '/app/skills/implement-issue/SKILL.md';

/** Skill the review Job loads. */
export const REVIEW_SKILL_PATH = '/app/skills/review-pr/SKILL.md';

/** Label a failed deploy leaves on the Issue, so the Developer can find it. */
export const DEPLOY_FAILED_LABEL = 'deploy-failed';

function prefix(kind: AgentRunKind): string {
  if (kind === 'review') return 'agent-review';
  if (kind === 'deploy') return 'yaaabk-deploy';
  return 'agent';
}

/** The Job name for a run. */
export function jobName(
  issueId: string,
  attempt: number,
  kind: AgentRunKind = 'implement-issue',
): string {
  const base = `${prefix(kind)}-${issueId}`;
  return kind === 'review' ? `${base}-${attempt}` : `${base}-attempt-${attempt}`;
}

/** The working PVC name for a run, retained after the Job ends. */
export function pvcName(
  issueId: string,
  attempt: number,
  kind: AgentRunKind = 'implement-issue',
): string {
  return `${prefix(kind)}-work-${issueId}-${attempt}`;
}

/** The per-attempt Secret name holding the OpenRouter key, when one is used. */
export function openrouterSecretName(
  issueId: string,
  attempt: number,
  kind: AgentRunKind = 'implement-issue',
): string {
  return `${prefix(kind)}-openrouter-${issueId}-${attempt}`;
}

/** The per-attempt Secret name holding the run's GitHub token. */
export function githubTokenSecretName(
  issueId: string,
  attempt: number,
  kind: AgentRunKind = 'implement-issue',
): string {
  return `${prefix(kind)}-github-${issueId}-${attempt}`;
}
