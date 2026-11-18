import { describe, expect, it } from 'vitest';
import type { AgentConfig } from './config';
import type {
  AgentDependencies,
  AgentIssue,
  AgentPullRequest,
  Checks,
  Git,
  GitHub,
  Kubectl,
  OpenCode,
  Reporter,
  SpendMeter,
} from './ports';
import { AUTOMERGE_LABEL } from './ports';
import { runAgent } from './run-agent';

const CONFIG: AgentConfig = {
  kind: 'implement-issue',
  issueNumber: 42,
  repoUrl: 'https://github.com/acme/todo-app',
  githubToken: 'gh-token',
  openrouterApiKey: 'sk-or-key',
  maxAttempts: 3,
};

const REVIEW_CONFIG: AgentConfig = {
  ...CONFIG,
  kind: 'review',
  pullNumber: 7,
  branch: 'agent/issue-42',
};

const DEPLOY_CONFIG: AgentConfig = {
  kind: 'deploy',
  issueNumber: 42,
  repoUrl: 'https://github.com/acme/todo-app',
  githubToken: 'gh-token',
  openrouterApiKey: '',
  maxAttempts: 3,
  commitSha: 'merge-sha-7',
  namespace: 'yaaabk-a1b2c3d4',
  deploymentName: 'todo-app',
  deployPath: 'deploy',
  branch: 'main',
};

const ISSUE: AgentIssue = { number: 42, title: 'Add login', body: 'With OAuth.' };

interface Fakes {
  deps: AgentDependencies;
  calls: string[];
  reports: Array<{
    prUrl: string | null;
    logs: string;
    costCents?: number;
    commitSha?: string;
    deployOutcome?: 'success' | 'failed';
  }>;
  pullRequests: AgentPullRequest;
  reviews: Array<{ pullNumber: number; event: string; body: string }>;
}

function fakes(
  overrides: {
    exitCode?: number;
    checksPassed?: boolean;
    reviewExitCode?: number;
    verdict?: { event: 'approve' | 'request-changes'; body: string };
    /** Message the clone step fails with, when the deploy never reaches the cluster. */
    cloneError?: string;
    /** Message the rollout step fails with, when the deploy should fail. */
    deployError?: string;
    /** Whether the Deployment has a previous revision to roll back to. */
    rolledBack?: boolean;
    /** Logs the deploy Job captures from the Deployment's pods. */
    podLogs?: string;
    /** USD the run's key has spent before and after the LLM call. */
    usage?: { before: number | undefined; after: number | undefined };
  } = {},
): Fakes {
  const calls: string[] = [];
  const reports: Array<{
    prUrl: string | null;
    logs: string;
    costCents?: number;
    commitSha?: string;
    deployOutcome?: 'success' | 'failed';
  }> = [];
  const reviews: Array<{ pullNumber: number; event: string; body: string }> = [];
  const pullRequests: AgentPullRequest = {
    number: 7,
    url: 'https://github.com/acme/todo-app/pull/7',
  };
  // A meter that reports whatever the test set, or nothing when unset.
  const usage = overrides.usage ?? { before: undefined, after: undefined };
  const meterReads: Array<number | undefined> = [usage.before, usage.after];
  const spend: SpendMeter = {
    async usageUsd() {
      return meterReads.shift();
    },
  };

  const git: Git = {
    async clone(input) {
      calls.push(`clone:${input.repoUrl}->${input.directory}`);
      if (overrides.cloneError !== undefined) throw new Error(overrides.cloneError);
    },
    async createBranch(directory, branch) {
      calls.push(`branch:${directory}:${branch}`);
    },
    async checkoutBranch(directory, branch) {
      calls.push(`checkout:${directory}:${branch}`);
    },
    async checkoutCommit(directory, sha) {
      calls.push(`checkout-commit:${directory}:${sha}`);
    },
    async commitAll(directory, message) {
      calls.push(`commit:${directory}:${message}`);
    },
    async push(directory, branch, options) {
      calls.push(`push:${directory}:${branch}${options?.force === true ? ':force' : ''}`);
    },
    async diff(directory) {
      calls.push(`diff:${directory}`);
      return 'diff --git a/src/a.ts b/src/a.ts';
    },
  };
  const kubectl: Kubectl = {
    async applyServerSide({ directory, namespace, path }) {
      calls.push(`apply:${directory}:${namespace}:${path}`);
    },
    async waitForRollout({ namespace, deploymentName }) {
      calls.push(`rollout:${namespace}:${deploymentName}`);
      if (overrides.deployError !== undefined) throw new Error(overrides.deployError);
    },
    async checkHealth({ namespace, serviceName }) {
      calls.push(`health:${namespace}:${serviceName}`);
    },
    async labelDeployment({ namespace, deploymentName, labelKey, labelValue }) {
      calls.push(`label:${namespace}:${deploymentName}:${labelKey}=${labelValue}`);
    },
    async undoRollout({ namespace, deploymentName }) {
      const rolledBack = overrides.rolledBack ?? true;
      calls.push(
        `undo:${namespace}:${deploymentName}:${rolledBack ? 'rolled-back' : 'no-revision'}`,
      );
      return { rolledBack };
    },
    async podLogs({ namespace, deploymentName }) {
      calls.push(`pod-logs:${namespace}:${deploymentName}`);
      return overrides.podLogs ?? 'pod log line';
    },
  };
  const openCode: OpenCode = {
    async implement(input) {
      calls.push(`implement:${input.directory}`);
      return { exitCode: overrides.exitCode ?? 0, output: 'implemented' };
    },
    async review(input) {
      calls.push(`review:${input.directory}`);
      return {
        exitCode: overrides.reviewExitCode ?? 0,
        output: 'reviewed',
        verdict: overrides.verdict ?? { event: 'approve', body: 'Looks good.' },
      };
    },
  };
  const checks: Checks = {
    async run(directory) {
      calls.push(`checks:${directory}`);
      return { passed: overrides.checksPassed ?? true, output: 'checks ok' };
    },
  };
  const github: GitHub = {
    async fetchIssue(number) {
      calls.push(`fetch:${number}`);
      return ISSUE;
    },
    async openPullRequest(input) {
      calls.push(`pr:${input.branch}:${input.labels.join(',')}`);
      return pullRequests;
    },
    async createReview(input) {
      calls.push(`review-post:${input.pullNumber}:${input.event}`);
      reviews.push(input);
    },
  };
  const reporter: Reporter = {
    async report(input) {
      calls.push('report');
      reports.push(input);
    },
  };

  return {
    deps: {
      git,
      kubectl,
      openCode,
      checks,
      github,
      reporter,
      spend,
      directory: '/work/repo',
    },
    calls,
    reports,
    pullRequests,
    reviews,
  };
}

describe('runAgent', () => {
  it('implements the issue and opens an automerge pull request', async () => {
    const { deps, calls, reports, pullRequests } = fakes();

    const outcome = await runAgent(CONFIG, deps);

    expect(calls).toEqual([
      'fetch:42',
      'clone:https://github.com/acme/todo-app->/work/repo',
      'branch:/work/repo:agent/issue-42',
      'implement:/work/repo',
      'checks:/work/repo',
      'commit:/work/repo:Add login (#42)',
      'push:/work/repo:agent/issue-42',
      `pr:agent/issue-42:${AUTOMERGE_LABEL}`,
      'report',
    ]);
    expect(outcome).toEqual({
      ok: true,
      prUrl: pullRequests.url,
      branch: 'agent/issue-42',
    });
    expect(reports).toEqual([{ prUrl: pullRequests.url, logs: 'implemented\nchecks ok' }]);
  });

  it('reports the LLM spend of the attempt in whole cents', async () => {
    // The run's key spent $0.50 before the model call and $0.75 after it, so
    // the attempt cost 25 cents.
    const { deps, reports } = fakes({ usage: { before: 0.5, after: 0.75 } });

    await runAgent(CONFIG, deps);

    expect(reports).toEqual([
      {
        prUrl: 'https://github.com/acme/todo-app/pull/7',
        logs: 'implemented\nchecks ok',
        costCents: 25,
      },
    ]);
  });

  it('reports a failed attempt and opens no pull request when checks fail', async () => {
    const { deps, calls, reports } = fakes({ checksPassed: false });

    const outcome = await runAgent(CONFIG, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'checks-failed' });
    expect(calls).not.toContain('push:/work/repo:agent/issue-42');
    expect(calls.some((call) => call.startsWith('pr:'))).toBe(false);
    expect(reports).toEqual([{ prUrl: null, logs: 'implemented\nchecks ok' }]);
  });

  it('reports a failed attempt when OpenCode exits non-zero', async () => {
    const { deps, calls, reports } = fakes({ exitCode: 1 });

    const outcome = await runAgent(CONFIG, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'implementation-failed' });
    expect(calls).not.toContain('checks:/work/repo');
    expect(reports).toEqual([{ prUrl: null, logs: 'implemented' }]);
  });

  it('checks out the pull request branch for a fix attempt and force-pushes it', async () => {
    const { deps, calls } = fakes();

    const outcome = await runAgent({ ...CONFIG, branch: 'agent/issue-42' }, deps);

    expect(calls).toEqual([
      'fetch:42',
      'clone:https://github.com/acme/todo-app->/work/repo',
      'checkout:/work/repo:agent/issue-42',
      'implement:/work/repo',
      'checks:/work/repo',
      'commit:/work/repo:Add login (#42)',
      'push:/work/repo:agent/issue-42:force',
      `pr:agent/issue-42:${AUTOMERGE_LABEL}`,
      'report',
    ]);
    expect(outcome).toMatchObject({ ok: true, branch: 'agent/issue-42' });
  });

  it('reviews a pull request and posts the verdict', async () => {
    const { deps, calls, reports, reviews } = fakes({
      verdict: { event: 'request-changes', body: 'Please fix src/a.ts:12.' },
    });

    const outcome = await runAgent(REVIEW_CONFIG, deps);

    expect(calls).toEqual([
      'fetch:42',
      'clone:https://github.com/acme/todo-app->/work/repo',
      'checkout:/work/repo:agent/issue-42',
      'diff:/work/repo',
      'review:/work/repo',
      'review-post:7:request-changes',
      'report',
    ]);
    expect(reviews).toEqual([
      { pullNumber: 7, event: 'request-changes', body: 'Please fix src/a.ts:12.' },
    ]);
    // The verdict is also reported to YAAABK so the app can show it without
    // the Developer opening the pull request.
    expect(reports[0]).toMatchObject({
      reviewVerdict: 'request-changes',
      reviewBody: 'Please fix src/a.ts:12.',
    });
    expect(outcome).toMatchObject({
      ok: true,
      branch: 'agent/issue-42',
      prUrl: 'https://github.com/acme/todo-app/pull/7',
    });
    // The review run reports the pull request it judged, never a new one.
    expect(reports).toEqual([
      {
        prUrl: 'https://github.com/acme/todo-app/pull/7',
        logs: 'reviewed',
        reviewVerdict: 'request-changes',
        reviewBody: 'Please fix src/a.ts:12.',
      },
    ]);
  });

  it('reports the LLM spend of a review in whole cents', async () => {
    // The review key spent $1.00 before the model call and $1.10 after it, so
    // the review cost 10 cents.
    const { deps, reports } = fakes({ usage: { before: 1.0, after: 1.1 } });

    await runAgent(REVIEW_CONFIG, deps);

    expect(reports).toEqual([
      {
        prUrl: 'https://github.com/acme/todo-app/pull/7',
        logs: 'reviewed',
        costCents: 10,
        reviewVerdict: 'approve',
        reviewBody: 'Looks good.',
      },
    ]);
  });

  it('posts no review and reports a failure when the review itself fails', async () => {
    const { deps, calls, reports, reviews } = fakes({ reviewExitCode: 1 });

    const outcome = await runAgent(REVIEW_CONFIG, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'review-failed' });
    expect(reviews).toEqual([]);
    expect(calls).not.toContain('review-post:7:approve');
    expect(reports).toEqual([{ prUrl: null, logs: 'reviewed' }]);
  });

  it('deploys a merged commit: clones, checks out SHA, applies, waits for rollout, checks health, labels SHA, and reports success', async () => {
    const { deps, calls, reports } = fakes();

    const outcome = await runAgent(DEPLOY_CONFIG, deps);

    expect(calls).toEqual([
      'clone:https://github.com/acme/todo-app->/work/repo',
      'checkout-commit:/work/repo:merge-sha-7',
      'apply:/work/repo:yaaabk-a1b2c3d4:deploy',
      'rollout:yaaabk-a1b2c3d4:todo-app',
      'health:yaaabk-a1b2c3d4:todo-app',
      'label:yaaabk-a1b2c3d4:todo-app:yaaabk.io/deployed-sha=merge-sha-7',
      'report',
    ]);
    expect(outcome).toEqual({
      ok: true,
      prUrl: '',
      branch: 'main',
      commitSha: 'merge-sha-7',
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.prUrl).toBeNull();
    expect(reports[0]?.commitSha).toBe('merge-sha-7');
    expect(reports[0]?.deployOutcome).toBe('success');
  });

  it('captures pod logs, rolls back, and reports a failed deploy when the rollout fails', async () => {
    const { deps, calls, reports } = fakes({
      deployError: 'rollout timed out',
      podLogs: 'Error: CrashLoopBackOff',
    });

    const outcome = await runAgent(DEPLOY_CONFIG, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'deploy-failed' });
    expect(calls).toEqual([
      'clone:https://github.com/acme/todo-app->/work/repo',
      'checkout-commit:/work/repo:merge-sha-7',
      'apply:/work/repo:yaaabk-a1b2c3d4:deploy',
      'rollout:yaaabk-a1b2c3d4:todo-app',
      'pod-logs:yaaabk-a1b2c3d4:todo-app',
      'undo:yaaabk-a1b2c3d4:todo-app:rolled-back',
      'report',
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      prUrl: null,
      commitSha: 'merge-sha-7',
      deployOutcome: 'failed',
    });
    expect(reports[0]?.logs).toContain('rollout timed out');
    expect(reports[0]?.logs).toContain('Error: CrashLoopBackOff');
    expect(reports[0]?.logs).toContain('Rolled back to the previous revision');
  });

  it('reports the failure without a rollback when the Deployment has no previous revision', async () => {
    const { deps, reports } = fakes({
      deployError: 'rollout timed out',
      rolledBack: false,
      podLogs: 'Error: CrashLoopBackOff',
    });

    const outcome = await runAgent(DEPLOY_CONFIG, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'deploy-failed' });
    expect(reports[0]?.deployOutcome).toBe('failed');
    expect(reports[0]?.logs).toContain('No previous revision to roll back');
  });

  it('does not roll back a deploy that never reached the cluster', async () => {
    const { deps, calls, reports } = fakes({ cloneError: 'repository not found' });

    const outcome = await runAgent(DEPLOY_CONFIG, deps);

    expect(outcome).toMatchObject({ ok: false, reason: 'deploy-failed' });
    expect(calls).toEqual(['clone:https://github.com/acme/todo-app->/work/repo', 'report']);
    expect(reports[0]?.deployOutcome).toBe('failed');
    expect(reports[0]?.logs).toContain('repository not found');
  });
});
