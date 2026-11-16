/** Default number of implementation attempts before a human is asked to step in. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** What the Job is running: implementing an Issue, or reviewing a pull request. */
export type AgentRunKind = 'implement-issue' | 'review';

export const AGENT_RUN_KINDS: readonly AgentRunKind[] = ['implement-issue', 'review'];

/** Narrows an unknown value to an {@link AgentRunKind}. */
export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return typeof value === 'string' && (AGENT_RUN_KINDS as readonly string[]).includes(value);
}

export interface AgentConfig {
  /** What this Job is for. */
  kind: AgentRunKind;
  /** GitHub issue number this agent is scoped to. */
  issueNumber: number;
  /** Clone URL of the Project repository. */
  repoUrl: string;
  /** Short-lived token used to clone, push branches and open pull requests. */
  githubToken: string;
  /** Per-issue key used for LLM calls; carries the issue budget. */
  openrouterApiKey: string;
  /** Maximum implementation attempts allowed for the issue. */
  maxAttempts: number;
  /** YAAABK run id, when the Job was given one, so it can report back. */
  runId?: string;
  /** Token authenticating the report callback, when the Job was given one. */
  runToken?: string;
  /** Base URL of the YAAABK API, when the Job was given one. */
  apiUrl?: string;
  /**
   * The branch to work on: a fix attempt's pull request branch, or the branch a
   * review checks out. Absent for a fresh implement attempt, which branches from
   * the default branch.
   */
  branch?: string;
  /** The pull request a review judges, when the Job is a review run. */
  pullNumber?: number;
  /**
   * Reviewer summary a fix attempt must address, when the Job was spawned in
   * response to a request-changes review.
   */
  reviewFeedback?: string;
  /**
   * Base URL for OpenRouter's API, used to read the run's key usage. Defaults
   * to `https://openrouter.ai/api/v1`; overridable for tests and proxies.
   */
  openrouterBaseUrl?: string;
}

type Env = Record<string, string | undefined>;

function require(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInt(env: Env, name: string, fallback?: number): number {
  const raw = env[name];
  if ((raw === undefined || raw.trim() === '') && fallback !== undefined) {
    return fallback;
  }
  const value = Number(require(env, name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, received: ${raw}`);
  }
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Reads and validates the agent's configuration from the environment.
 *
 * Called at container start so a misconfigured Job fails immediately rather
 * than midway through an implementation attempt.
 */
export function loadAgentConfig(env: Env): AgentConfig {
  const runId = optional(env, 'AGENT_RUN_ID');
  const runToken = optional(env, 'AGENT_RUN_TOKEN');
  const apiUrl = optional(env, 'YAAABK_API_URL');
  const branch = optional(env, 'BRANCH');
  const pullNumber = optional(env, 'PULL_NUMBER');
  const reviewFeedback = optional(env, 'REVIEW_FEEDBACK');
  const openrouterBaseUrl = optional(env, 'OPENROUTER_BASE_URL');
  const rawKind = optional(env, 'AGENT_RUN_KIND') ?? 'implement-issue';
  if (!isAgentRunKind(rawKind)) {
    throw new Error(`AGENT_RUN_KIND must be one of ${AGENT_RUN_KINDS.join(', ')}`);
  }
  if (rawKind === 'review') {
    if (branch === undefined) {
      throw new Error('Missing required environment variable: BRANCH for a review run');
    }
    if (pullNumber === undefined) {
      throw new Error('Missing required environment variable: PULL_NUMBER for a review run');
    }
  }
  let parsedPullNumber: number | undefined;
  if (pullNumber !== undefined) {
    parsedPullNumber = Number(pullNumber);
    if (!Number.isInteger(parsedPullNumber) || parsedPullNumber < 1) {
      throw new Error(`PULL_NUMBER must be a positive integer, received: ${pullNumber}`);
    }
  }
  return {
    kind: rawKind,
    issueNumber: positiveInt(env, 'ISSUE_NUMBER'),
    repoUrl: require(env, 'REPO_URL'),
    githubToken: require(env, 'GITHUB_TOKEN'),
    openrouterApiKey: require(env, 'OPENROUTER_API_KEY'),
    maxAttempts: positiveInt(env, 'MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    ...(runId === undefined ? {} : { runId }),
    ...(runToken === undefined ? {} : { runToken }),
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(branch === undefined ? {} : { branch }),
    ...(parsedPullNumber === undefined ? {} : { pullNumber: parsedPullNumber }),
    ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
    ...(openrouterBaseUrl === undefined ? {} : { openrouterBaseUrl }),
  };
}
