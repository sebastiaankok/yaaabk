import type { AgentConfig } from './config';
import { AUTOMERGE_LABEL, defaultBranch, type AgentDependencies, type AgentOutcome } from './ports';
import { buildImplementPrompt, pullRequestBody, pullRequestTitle } from './prompt';

const DEFAULT_DIRECTORY = '/work/repo';

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
export async function runAgent(
  config: AgentConfig,
  deps: AgentDependencies,
): Promise<AgentOutcome> {
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

  const implemented = await deps.openCode.implement({
    directory,
    prompt: buildImplementPrompt(issue, config),
  });
  logs.push(implemented.output);
  if (implemented.exitCode !== 0) {
    await deps.reporter.report({ prUrl: null, logs: logs.join('\n') });
    return {
      ok: false,
      reason: 'implementation-failed',
      output: implemented.output,
      branch,
    };
  }

  const checks = await deps.checks.run(directory);
  logs.push(checks.output);
  if (!checks.passed) {
    await deps.reporter.report({ prUrl: null, logs: logs.join('\n') });
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

  await deps.reporter.report({ prUrl: pullRequest.url, logs: logs.join('\n') });
  return { ok: true, prUrl: pullRequest.url, branch };
}
