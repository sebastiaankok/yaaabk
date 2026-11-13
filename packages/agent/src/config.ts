/** Default number of implementation attempts before a human is asked to step in. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface AgentConfig {
  /** GitHub issue number this agent is scoped to. */
  issueNumber: number;
  /** Clone URL of the Project repository. */
  repoUrl: string;
  /** Short-lived token used to push branches and open pull requests. */
  githubToken: string;
  /** Per-issue key used for LLM calls; carries the issue budget. */
  openrouterApiKey: string;
  /** Maximum implementation attempts allowed for the issue. */
  maxAttempts: number;
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

/**
 * Reads and validates the agent's configuration from the environment.
 *
 * Called at container start so a misconfigured Job fails immediately rather
 * than midway through an implementation attempt.
 */
export function loadAgentConfig(env: Env): AgentConfig {
  return {
    issueNumber: positiveInt(env, 'ISSUE_NUMBER'),
    repoUrl: require(env, 'REPO_URL'),
    githubToken: require(env, 'GITHUB_TOKEN'),
    openrouterApiKey: require(env, 'OPENROUTER_API_KEY'),
    maxAttempts: positiveInt(env, 'MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
  };
}
