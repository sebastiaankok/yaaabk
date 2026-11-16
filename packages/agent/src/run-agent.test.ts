import { describe, expect, it } from 'vitest';
import type { AgentConfig } from './config';
import type {
  AgentDependencies,
  AgentIssue,
  AgentPullRequest,
  Checks,
  Git,
  GitHub,
  OpenCode,
  Reporter,
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

const ISSUE: AgentIssue = { number: 42, title: 'Add login', body: 'With OAuth.' };

interface Fakes {
  deps: AgentDependencies;
  calls: string[];
  reports: Array<{ prUrl: string | null; logs: string }>;
  pullRequests: AgentPullRequest;
  reviews: Array<{ pullNumber: number; event: string; body: string }>;
}

function fakes(
  overrides: {
    exitCode?: number;
    checksPassed?: boolean;
    reviewExitCode?: number;
    verdict?: { event: 'approve' | 'request-changes'; body: string };
  } = {},
): Fakes {
  const calls: string[] = [];
  const reports: Array<{ prUrl: string | null; logs: string }> = [];
  const reviews: Array<{ pullNumber: number; event: string; body: string }> = [];
  const pullRequests: AgentPullRequest = {
    number: 7,
    url: 'https://github.com/acme/todo-app/pull/7',
  };

  const git: Git = {
    async clone(input) {
      calls.push(`clone:${input.repoUrl}->${input.directory}`);
    },
    async createBranch(directory, branch) {
      calls.push(`branch:${directory}:${branch}`);
    },
    async checkoutBranch(directory, branch) {
      calls.push(`checkout:${directory}:${branch}`);
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
    deps: { git, openCode, checks, github, reporter, directory: '/work/repo' },
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
    expect(outcome).toMatchObject({
      ok: true,
      branch: 'agent/issue-42',
      prUrl: 'https://github.com/acme/todo-app/pull/7',
    });
    // The review run reports the pull request it judged, never a new one.
    expect(reports).toEqual([
      { prUrl: 'https://github.com/acme/todo-app/pull/7', logs: 'reviewed' },
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
});
