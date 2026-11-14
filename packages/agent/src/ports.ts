/**
 * The ports the agent orchestrator drives.
 *
 * The real adapters shell out to `git`, `gh` and OpenCode; tests supply fakes.
 * Keeping them as narrow ports lets the clone → implement → checks → PR flow be
 * verified without a cluster, a repository or an LLM.
 */

import type { AgentConfig } from './config';

/** The Issue as the agent needs it. */
export interface AgentIssue {
  number: number;
  title: string;
  body: string;
}

/** The pull request the agent opened. */
export interface AgentPullRequest {
  number: number;
  url: string;
}

export interface CloneInput {
  repoUrl: string;
  token: string;
  directory: string;
}

export interface Git {
  /** Clones the repository into `directory`, authenticated with the token. */
  clone(input: CloneInput): Promise<void>;
  /** Creates and checks out `branch`, replacing any stale local branch. */
  createBranch(directory: string, branch: string): Promise<void>;
  /** Stages and commits every change. */
  commitAll(directory: string, message: string): Promise<void>;
  /** Pushes `branch` to `origin`. */
  push(directory: string, branch: string, token: string): Promise<void>;
}

export interface OpenCode {
  /** Runs OpenCode with the implement-issue prompt in the working directory. */
  implement(input: { directory: string; prompt: string }): Promise<{
    exitCode: number;
    output: string;
  }>;
}

export interface Checks {
  /** Runs the project's pre-commit hooks; reports whether they passed. */
  run(directory: string): Promise<{ passed: boolean; output: string }>;
}

export interface GitHub {
  fetchIssue(issueNumber: number): Promise<AgentIssue>;
  openPullRequest(input: {
    branch: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<AgentPullRequest>;
}

export interface Reporter {
  /** Reports the outcome back to YAAABK. */
  report(input: { prUrl: string | null; logs: string }): Promise<void>;
}

/** Everything the orchestrator needs, injected so it stays testable. */
export interface AgentDependencies {
  git: Git;
  openCode: OpenCode;
  checks: Checks;
  github: GitHub;
  reporter: Reporter;
  /** Working directory the repository is cloned into. Defaults to `/work/repo`. */
  directory?: string;
  /** Branch the agent pushes to. Defaults to `agent/issue-<number>`. */
  branchFor?: (config: AgentConfig) => string;
}

/** The outcome of one implementation attempt. */
export type AgentOutcome =
  | { ok: true; prUrl: string; branch: string }
  | {
      ok: false;
      reason: 'implementation-failed' | 'checks-failed';
      output: string;
      branch: string;
    };

/** The label YAAABK's CI Tracker watches to auto-merge a pull request. */
export const AUTOMERGE_LABEL = 'automerge';

/** The default branch name for an Issue's work. */
export function defaultBranch(config: AgentConfig): string {
  return `agent/issue-${config.issueNumber}`;
}
