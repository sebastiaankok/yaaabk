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
  issueNumber: 42,
  repoUrl: 'https://github.com/acme/todo-app',
  githubToken: 'gh-token',
  openrouterApiKey: 'sk-or-key',
  maxAttempts: 3,
};

const ISSUE: AgentIssue = { number: 42, title: 'Add login', body: 'With OAuth.' };

interface Fakes {
  deps: AgentDependencies;
  calls: string[];
  reports: Array<{ prUrl: string | null; logs: string }>;
  pullRequests: AgentPullRequest;
}

function fakes(
  overrides: {
    exitCode?: number;
    checksPassed?: boolean;
  } = {},
): Fakes {
  const calls: string[] = [];
  const reports: Array<{ prUrl: string | null; logs: string }> = [];
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
    async commitAll(directory, message) {
      calls.push(`commit:${directory}:${message}`);
    },
    async push(directory, branch) {
      calls.push(`push:${directory}:${branch}`);
    },
  };
  const openCode: OpenCode = {
    async implement(input) {
      calls.push(`implement:${input.directory}`);
      return { exitCode: overrides.exitCode ?? 0, output: 'implemented' };
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
});
