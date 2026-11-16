import type { AgentConfig } from './config';
import { AUTOMERGE_LABEL, defaultBranch, type AgentDependencies, type AgentOutcome } from './ports';
import {
  buildImplementPrompt,
  buildReviewPrompt,
  pullRequestBody,
  pullRequestTitle,
} from './prompt';

const DEFAULT_DIRECTORY = '/work/repo';

/** Converts a USD amount to whole cents, rounding to the nearest cent. */
function centsFromUsd(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * Measures the LLM spend of one model call.
 *
 * Reads the run's OpenRouter key usage before and after `call`, returning the
 * difference in whole cents. A meter that cannot read usage (before or after)
 * yields `undefined`, so the run reports no cost rather than a wrong one.
 */
async function measureSpend<T>(
  spend: AgentDependencies['spend'],
  call: () => Promise<T>,
): Promise<{ result: T; costCents: number | undefined }> {
  const before = await spend.usageUsd();
  const result = await call();
  const after = await spend.usageUsd();
  const costCents =
    before === undefined || after === undefined ? undefined : centsFromUsd(after - before);
  return { result, costCents };
}

/** The pull request a review run judges, validated by the config loader. */
function requireReviewTarget(config: AgentConfig): { pullNumber: number; branch: string } {
  if (config.pullNumber === undefined || config.branch === undefined) {
    throw new Error('A review run requires a branch and a pull number');
  }
  return { pullNumber: config.pullNumber, branch: config.branch };
}

/** The URL of the pull request a review run judged. */
function pullRequestUrl(repoUrl: string, pullNumber: number): string {
  return `${repoUrl.replace(/\.git$/, '')}/pull/${pullNumber}`;
}

/**
 * Runs one implementation attempt for an Issue.
 *
 * The flow is the Job's whole purpose: fetch the Issue, clone the repository,
 * branch, let OpenCode implement the change, run the project's checks, and —
 * only once the checks pass — commit, push and open a pull request labelled for
 * automerge. Whatever happens, the attempt reports its outcome back to YAAABK so
 * the Agent Manager can retry or escalate.
 *
 * A non-zero OpenCode exit or failing checks is reported as a failure and no
 * pull request is opened, so a broken attempt never lands a red PR.
 */
async function runImplement(config: AgentConfig, deps: AgentDependencies): Promise<AgentOutcome> {
  const directory = deps.directory ?? DEFAULT_DIRECTORY;
  const fix = config.branch !== undefined;
  const branch = config.branch ?? (deps.branchFor ?? defaultBranch)(config);
  const issue = await deps.github.fetchIssue(config.issueNumber);
  const logs: string[] = [];

  await deps.git.clone({ repoUrl: config.repoUrl, token: config.githubToken, directory });
  if (fix) {
    await deps.git.checkoutBranch(directory, branch);
  } else {
    await deps.git.createBranch(directory, branch);
  }

  const implemented = await measureSpend(deps.spend, () =>
    deps.openCode.implement({
      directory,
      prompt: buildImplementPrompt(issue, config),
    }),
  );
  const { result, costCents } = implemented;
  logs.push(result.output);
  if (result.exitCode !== 0) {
    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      ...(costCents === undefined ? {} : { costCents }),
    });
    return {
      ok: false,
      reason: 'implementation-failed',
      output: result.output,
      branch,
    };
  }

  const checks = await deps.checks.run(directory);
  logs.push(checks.output);
  if (!checks.passed) {
    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      ...(costCents === undefined ? {} : { costCents }),
    });
    return { ok: false, reason: 'checks-failed', output: checks.output, branch };
  }

  await deps.git.commitAll(directory, `${pullRequestTitle(issue)} (#${issue.number})`);
  await deps.git.push(directory, branch, { force: fix });
  const pullRequest = await deps.github.openPullRequest({
    branch,
    title: pullRequestTitle(issue),
    body: pullRequestBody(issue),
    labels: [AUTOMERGE_LABEL],
  });

  await deps.reporter.report({
    prUrl: pullRequest.url,
    logs: logs.join('\n'),
    ...(costCents === undefined ? {} : { costCents }),
  });
  return { ok: true, prUrl: pullRequest.url, branch };
}

/**
 * Runs one review of an Agent-opened pull request.
 *
 * The Job checks out the pull request branch, lets OpenCode judge the diff
 * against the Issue, then posts the verdict it wrote as a formal GitHub review.
 * The runner — not the reviewer — holds the posting authority, so a review run
 * can never push code or merge.
 */
async function runReview(config: AgentConfig, deps: AgentDependencies): Promise<AgentOutcome> {
  const directory = deps.directory ?? DEFAULT_DIRECTORY;
  const { pullNumber, branch } = requireReviewTarget(config);
  const issue = await deps.github.fetchIssue(config.issueNumber);
  const logs: string[] = [];

  await deps.git.clone({ repoUrl: config.repoUrl, token: config.githubToken, directory });
  await deps.git.checkoutBranch(directory, branch);

  const diff = await deps.git.diff(directory);
  const reviewed = await measureSpend(deps.spend, () =>
    deps.openCode.review({
      directory,
      prompt: buildReviewPrompt(issue, { pullNumber, branch, diff }),
    }),
  );
  const { result, costCents } = reviewed;
  logs.push(result.output);
  if (result.exitCode !== 0) {
    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      ...(costCents === undefined ? {} : { costCents }),
    });
    return {
      ok: false,
      reason: 'review-failed',
      output: result.output,
      branch,
    };
  }

  await deps.github.createReview({
    pullNumber,
    event: result.verdict.event,
    body: result.verdict.body,
  });

  const prUrl = pullRequestUrl(config.repoUrl, pullNumber);
  await deps.reporter.report({
    prUrl,
    logs: logs.join('\n'),
    ...(costCents === undefined ? {} : { costCents }),
  });
  return { ok: true, prUrl, branch };
}

/** Runs the attempt this Job was spawned for, dispatching on its kind. */
export async function runAgent(
  config: AgentConfig,
  deps: AgentDependencies,
): Promise<AgentOutcome> {
  return config.kind === 'review' ? runReview(config, deps) : runImplement(config, deps);
}
