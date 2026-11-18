/**
 * The ports the agent orchestrator drives.
 *
 * The real adapters shell out to `git`, `gh` and OpenCode; tests supply fakes.
 * Keeping them as narrow ports lets the clone → implement → checks → PR flow be
 * verified without a cluster, a repository or an LLM.
 */

import { issueBranch } from '@yaaabk/shared';
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

/** A formal review verdict the review run posts. */
export type ReviewEvent = 'approve' | 'request-changes';

export interface ReviewVerdict {
  event: ReviewEvent;
  body: string;
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
  /**
   * Fetches and checks out an existing remote `branch`, the way a fix attempt
   * picks up the pull request it is continuing.
   */
  checkoutBranch(directory: string, branch: string): Promise<void>;
  /** Checks out a specific commit SHA in detached HEAD. */
  checkoutCommit(directory: string, commitSha: string): Promise<void>;
  /** Stages and commits every change; a clean tree (the Agent already committed) is left as-is. */
  commitAll(directory: string, message: string): Promise<void>;
  /** Pushes `branch` to `origin`, force-updating it when `force` is set. */
  push(directory: string, branch: string, options?: { force?: boolean }): Promise<void>;
  /**
   * The pull request branch's diff against the branch it forked from, so a
   * review sees exactly what the change introduces.
   */
  diff(directory: string): Promise<string>;
}

export interface Kubectl {
  /** Applies the manifests in `path` with `kubectl apply --server-side`. */
  applyServerSide(input: { directory: string; namespace: string; path: string }): Promise<void>;
  /**
   * Pins the Deployment's container to the image built for the merged commit.
   *
   * Applying the manifests alone cannot do this: the manifest is authored at
   * scaffold time and does not know the commit SHA the image was published
   * under.
   */
  setImage(input: {
    namespace: string;
    deploymentName: string;
    containerName: string;
    image: string;
  }): Promise<void>;
  /** Waits for the rollout of `deploymentName` to complete. */
  waitForRollout(input: {
    namespace: string;
    deploymentName: string;
    timeoutSeconds?: number;
  }): Promise<void>;
  /** Hits `/health` on `serviceName` (via `wget`) and verifies HTTP 200. */
  checkHealth(input: { namespace: string; serviceName: string }): Promise<void>;
  /** Labels the Deployment with `labelKey=labelValue`. */
  labelDeployment(input: {
    namespace: string;
    deploymentName: string;
    labelKey: string;
    labelValue: string;
  }): Promise<void>;
  /**
   * Rolls the Deployment back to its previous revision, when one exists.
   *
   * Returns `rolledBack: false` when the Deployment has no previous revision,
   * which is not a failure: a first deploy that never became healthy simply
   * leaves nothing to roll back to.
   */
  undoRollout(input: {
    namespace: string;
    deploymentName: string;
  }): Promise<{ rolledBack: boolean; error?: string }>;
  /** Captures the current logs of the Deployment's pods, for a failure report. */
  podLogs(input: { namespace: string; deploymentName: string }): Promise<string>;
}

export interface OpenCode {
  /** Runs OpenCode with the implement-issue prompt in the working directory. */
  implement(input: { directory: string; prompt: string }): Promise<{
    exitCode: number;
    output: string;
  }>;
  /**
   * Runs OpenCode with the review-pr prompt and reads back the verdict the
   * agent wrote to `.yaaabk/review.json`.
   */
  review(input: { directory: string; prompt: string }): Promise<{
    exitCode: number;
    output: string;
    verdict: ReviewVerdict;
  }>;
}

/**
 * Reads the run's OpenRouter key usage, in USD.
 *
 * The agent measures its LLM spend by reading this before and after the model
 * call: OpenRouter reports a key's total spend, so the difference across one
 * attempt is what that attempt cost. Reads are best-effort — a meter that
 * cannot reach OpenRouter returns `undefined`, and the run then reports no
 * cost rather than failing.
 */
export interface SpendMeter {
  /** Total USD the run's OpenRouter key has spent, or `undefined` if unknown. */
  usageUsd(): Promise<number | undefined>;
}

export interface Checks {
  /** Runs the project's pre-commit hooks; reports whether they passed. */
  run(directory: string): Promise<{ passed: boolean; output: string }>;
}

/**
 * Watches the container registry for the image a deploy is about to run.
 *
 * CI builds and pushes the image after the merge; the deploy Job can start
 * before that finishes. Waiting for the tag to appear avoids an
 * `ImagePullBackOff` that the rollout would mistake for a broken release.
 */
export interface Registry {
  /** Resolves once `image` is published, or rejects after `timeoutMs`. */
  waitForImage(input: { image: string; timeoutMs?: number }): Promise<void>;
}

export interface GitHub {
  fetchIssue(issueNumber: number): Promise<AgentIssue>;
  openPullRequest(input: {
    branch: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<AgentPullRequest>;
  /** Posts a formal approve / request-changes review on a pull request. */
  createReview(input: { pullNumber: number; event: ReviewEvent; body: string }): Promise<void>;
}

export interface Reporter {
  /**
   * Reports the outcome back to YAAABK. `costCents` is the run's LLM spend in
   * whole cents, when the meter could measure it; omitting it leaves the run's
   * cost unrecorded rather than zero.
   */
  report(input: {
    prUrl: string | null;
    logs: string;
    costCents?: number;
    /** The verdict a review run reached. Omitted by other kinds. */
    reviewVerdict?: 'approve' | 'request-changes';
    /** The reviewer's written summary. Omitted with {@link reviewVerdict}. */
    reviewBody?: string;
    commitSha?: string;
    /**
     * How a deploy run ended. A failed deploy is reported so YAAABK can record
     * the failure and surface it; a successful one records the deployed SHA.
     */
    deployOutcome?: 'success' | 'failed';
  }): Promise<void>;
}

/** Everything the orchestrator needs, injected so it stays testable. */
export interface AgentDependencies {
  git: Git;
  kubectl: Kubectl;
  /** Registry the deploy waits on. Omitted by tests that do not deploy. */
  registry?: Registry;
  openCode: OpenCode;
  checks: Checks;
  github: GitHub;
  reporter: Reporter;
  /** Reads the run's OpenRouter spend so a run can report what it cost. */
  spend: SpendMeter;
  /** Working directory the repository is cloned into. Defaults to `/work/repo`. */
  directory?: string;
  /** Branch the agent pushes to. Defaults to `agent/issue-<number>`. */
  branchFor?: (config: AgentConfig) => string;
}

/** The outcome of one implementation attempt. */
export type AgentOutcome =
  | { ok: true; prUrl: string; branch: string; commitSha?: string }
  | {
      ok: false;
      reason: 'implementation-failed' | 'checks-failed' | 'review-failed' | 'deploy-failed';
      output: string;
      branch: string;
    };

/** The label YAAABK's CI Tracker watches to auto-merge a pull request. */
export const AUTOMERGE_LABEL = 'automerge';

/** The default branch name for an Issue's work. */
export function defaultBranch(config: AgentConfig): string {
  return issueBranch(config.issueNumber);
}
