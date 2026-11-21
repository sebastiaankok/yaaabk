import type { TokenUsage } from '@yaaabk/shared';
import { parseRepoUrl } from './adapters';
import type { AgentConfig } from './config';
import {
  AUTOMERGE_LABEL,
  defaultBranch,
  type AgentDependencies,
  type AgentOutcome,
  type Checks,
} from './ports';
import {
  buildImplementPrompt,
  buildResolveConflictsPrompt,
  buildReviewPrompt,
  pullRequestBody,
  pullRequestTitle,
  REPOSITORY_DIRECTORY,
} from './prompt';

const DEFAULT_DIRECTORY = REPOSITORY_DIRECTORY;
const DEPLOYED_SHA_LABEL = 'yaaabk.io/deployed-sha';

/** Container name the template's Deployment declares. */
const DEPLOY_CONTAINER_NAME = 'app';

/**
 * The image CI publishes for a merged commit.
 *
 * The template's CI tags the image with `${{ github.sha }}` under
 * `ghcr.io/${{ github.repository }}`, so the deploy can derive the exact
 * reference from the repository URL and the merged commit.
 */
export function containerImage(repoUrl: string, commitSha: string): string {
  const { owner, repo } = parseRepoUrl(repoUrl);
  return `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}:${commitSha}`;
}

/**
 * Writes a progress line to the Job's stdout.
 *
 * The UI streams those logs live, so each phase is visible while the attempt
 * runs instead of only when it reports back.
 */
function progress(message: string): void {
  process.stdout.write(`[yaaabk] ${message}\n`);
}

/** Converts a USD amount to whole cents, rounding to the nearest cent. */
function centsFromUsd(usd: number): number {
  return Math.round(usd * 100);
}

/** The report field for measured token usage, omitted when unmeasured. */
function tokenReport(tokens: TokenUsage | null): { tokens?: TokenUsage } {
  return tokens === null ? {} : { tokens };
}

/**
 * Installs the project's dependencies once the repository is checked out.
 *
 * Every clone starts without `node_modules`, and OpenCode runs before the
 * post-run checks. Installing here lets the Agent read library sources, run
 * `bun run check` and use project scripts without discovering the missing
 * install itself. A failure is logged but not fatal: the checks run installs
 * again and is the authority on whether the attempt can proceed.
 */
async function installDependencies(
  checks: Checks,
  directory: string,
  logs: string[],
): Promise<void> {
  progress('installing dependencies');
  const installed = await checks.install(directory);
  if (!installed.passed) {
    logs.push(`bun install failed:\n${installed.output}`);
    progress('dependency install failed; continuing so the checks report it');
  }
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

/** The pull request a conflict-resolution run repairs, validated by the loader. */
function requireConflictTarget(config: AgentConfig): { pullNumber: number; branch: string } {
  if (config.pullNumber === undefined || config.branch === undefined) {
    throw new Error('A conflict-resolution run requires a branch and a pull number');
  }
  return { pullNumber: config.pullNumber, branch: config.branch };
}

/** The deploy target a deploy run acts on, validated by the config loader. */
function requireDeployTarget(config: AgentConfig): {
  commitSha: string;
  namespace: string;
  deploymentName: string;
} {
  if (
    config.commitSha === undefined ||
    config.namespace === undefined ||
    config.deploymentName === undefined
  ) {
    throw new Error('A deploy run requires a commit SHA, namespace, and deployment name');
  }
  return {
    commitSha: config.commitSha,
    namespace: config.namespace,
    deploymentName: config.deploymentName,
  };
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

  progress(`issue #${issue.number}: cloning ${config.repoUrl}`);
  await deps.git.clone({ repoUrl: config.repoUrl, token: config.githubToken, directory });
  if (fix) {
    await deps.git.checkoutBranch(directory, branch);
  } else {
    await deps.git.createBranch(directory, branch);
  }

  await installDependencies(deps.checks, directory, logs);

  progress(`branch ${branch}: running OpenCode (${config.model ?? 'default model'})`);
  const implemented = await measureSpend(deps.spend, () =>
    deps.openCode.implement({
      directory,
      prompt: buildImplementPrompt(issue, config),
    }),
  );
  const { result, costCents } = implemented;
  const tokens = result.tokens;
  logs.push(result.output);
  if (result.exitCode !== 0) {
    progress(`OpenCode failed with exit code ${result.exitCode}; reporting`);
    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      ...(costCents === undefined ? {} : { costCents }),
      ...tokenReport(tokens),
    });
    return {
      ok: false,
      reason: 'implementation-failed',
      output: result.output,
      branch,
    };
  }

  progress('OpenCode finished; running the project checks');
  const checks = await deps.checks.run(directory);
  logs.push(checks.output);
  if (!checks.passed) {
    progress('checks failed; reporting');
    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      ...(costCents === undefined ? {} : { costCents }),
      ...tokenReport(tokens),
    });
    return { ok: false, reason: 'checks-failed', output: checks.output, branch };
  }

  progress('checks passed; committing and pushing');
  await deps.git.commitAll(directory, `${pullRequestTitle(issue)} (#${issue.number})`);
  await deps.git.push(directory, branch, { force: fix });
  const pullRequest = await deps.github.openPullRequest({
    branch,
    title: pullRequestTitle(issue),
    body: pullRequestBody(issue),
    labels: [AUTOMERGE_LABEL],
  });
  progress(`opened pull request ${pullRequest.url}`);

  await deps.reporter.report({
    prUrl: pullRequest.url,
    logs: logs.join('\n'),
    ...(costCents === undefined ? {} : { costCents }),
    ...tokenReport(tokens),
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

  await installDependencies(deps.checks, directory, logs);

  progress(`reviewing pull request #${pullNumber} (${config.model ?? 'default model'})`);
  const diff = await deps.git.diff(directory);
  const reviewed = await measureSpend(deps.spend, () =>
    deps.openCode.review({
      directory,
      prompt: buildReviewPrompt(issue, { pullNumber, branch, diff }),
    }),
  );
  const { result, costCents } = reviewed;
  const tokens = result.tokens;
  logs.push(result.output);
  if (result.exitCode !== 0) {
    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      ...(costCents === undefined ? {} : { costCents }),
      ...tokenReport(tokens),
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
    // The verdict also goes to GitHub, but the Developer should see it in
    // YAAABK without opening the pull request.
    reviewVerdict: result.verdict.event,
    reviewBody: result.verdict.body,
    ...(costCents === undefined ? {} : { costCents }),
    ...tokenReport(tokens),
  });
  return { ok: true, prUrl, branch };
}

/**
 * Repairs a pull request branch that conflicts with the base branch.
 *
 * Clones the branch, merges the default branch into it, and — only when that
 * leaves conflicts — asks OpenCode to reconcile them. Then runs the project's
 * checks and force-pushes the branch, so CI and review re-run against the new
 * head. The Agent never opens or merges the pull request itself.
 */
async function runResolveConflicts(
  config: AgentConfig,
  deps: AgentDependencies,
): Promise<AgentOutcome> {
  const directory = deps.directory ?? DEFAULT_DIRECTORY;
  const { pullNumber, branch } = requireConflictTarget(config);
  const issue = await deps.github.fetchIssue(config.issueNumber);
  const logs: string[] = [];

  progress(`resolving conflicts on ${branch} against the default branch`);
  await deps.git.clone({ repoUrl: config.repoUrl, token: config.githubToken, directory });
  await deps.git.checkoutBranch(directory, branch);

  await installDependencies(deps.checks, directory, logs);

  const merged = await deps.git.mergeDefaultBranch(directory);
  if (merged.output.trim() !== '') logs.push(merged.output.trimEnd());
  if (!merged.ok) {
    const output = logs.join('\n');
    await deps.reporter.report({ prUrl: null, logs: output });
    return { ok: false, reason: 'conflict-resolution-failed', output, branch };
  }

  const conflicts = await deps.git.unmergedPaths(directory);
  let costCents: number | undefined;
  let tokens: TokenUsage | null = null;
  if (conflicts.length > 0 || merged.conflicted) {
    progress(`OpenCode resolving ${conflicts.length} conflicted file(s)`);
    const resolved = await measureSpend(deps.spend, () =>
      deps.openCode.resolveConflicts({
        directory,
        prompt: buildResolveConflictsPrompt(issue, {
          pullNumber,
          branch,
          paths: conflicts,
          mergeOutput: merged.output,
        }),
      }),
    );
    logs.push(resolved.result.output);
    costCents = resolved.costCents;
    tokens = resolved.result.tokens;
    if (resolved.result.exitCode !== 0) {
      const output = logs.join('\n');
      await deps.reporter.report({
        prUrl: null,
        logs: output,
        ...(costCents === undefined ? {} : { costCents }),
        ...tokenReport(tokens),
      });
      return { ok: false, reason: 'conflict-resolution-failed', output, branch };
    }

    const remaining = await deps.git.unmergedPaths(directory);
    if (remaining.length > 0) {
      logs.push(`Conflicts remain in: ${remaining.join(', ')}`);
      const output = logs.join('\n');
      await deps.reporter.report({
        prUrl: null,
        logs: output,
        ...(costCents === undefined ? {} : { costCents }),
        ...tokenReport(tokens),
      });
      return { ok: false, reason: 'conflict-resolution-failed', output, branch };
    }
  } else {
    progress('branch merged cleanly; no conflicts to resolve');
  }

  progress('conflict resolution finished; running the project checks');
  const checks = await deps.checks.run(directory);
  logs.push(checks.output);
  if (!checks.passed) {
    const output = logs.join('\n');
    await deps.reporter.report({
      prUrl: null,
      logs: output,
      ...(costCents === undefined ? {} : { costCents }),
      ...tokenReport(tokens),
    });
    return { ok: false, reason: 'checks-failed', output, branch };
  }

  progress('checks passed; committing and force-pushing the branch');
  await deps.git.commitAll(directory, `Resolve conflicts for #${issue.number}`);
  await deps.git.push(directory, branch, { force: true });

  const prUrl = pullRequestUrl(config.repoUrl, pullNumber);
  await deps.reporter.report({
    prUrl,
    logs: logs.join('\n'),
    ...(costCents === undefined ? {} : { costCents }),
    ...tokenReport(tokens),
  });
  return { ok: true, prUrl, branch };
}

/**
 * Runs a deploy for a merged commit.
 *
 * Clones the repository, checks out the merged commit SHA, applies the Project's
 * deploy manifests with `kubectl apply --server-side`, waits for the rollout to
 * complete, hits the Project's `/health` endpoint, labels the Deployment with
 * the deployed commit SHA, and reports success back to YAAABK.
 *
 * The target is checked against the Deployment's `yaaabk.io/deployed-sha` label
 * right before anything is applied: if that revision is the same commit or a
 * descendant of it, a newer deploy has already won and this run reports
 * `skipped` instead of rolling the application back.
 */
async function runDeploy(config: AgentConfig, deps: AgentDependencies): Promise<AgentOutcome> {
  const directory = deps.directory ?? DEFAULT_DIRECTORY;
  const { commitSha, namespace, deploymentName } = requireDeployTarget(config);
  const branch = config.branch ?? 'main';
  const deployPath = config.deployPath ?? 'deploy';
  const logs: string[] = [];
  let rollbackNeeded = false;

  try {
    await deps.git.clone({ repoUrl: config.repoUrl, token: config.githubToken, directory });
    logs.push(`Cloned ${config.repoUrl}`);

    await deps.git.checkoutCommit(directory, commitSha);
    logs.push(`Checked out ${commitSha}`);

    const image = containerImage(config.repoUrl, commitSha);
    progress(`deploying ${commitSha} to ${namespace} (${image})`);

    // CI builds the image after the merge and the deploy Job starts as soon
    // as the pull request is merged, so the tag is often a few seconds behind.
    // Waiting here keeps that race from surfacing as an ImagePullBackOff.
    if (deps.registry !== undefined) {
      progress(`waiting for ${image} to be published`);
      await deps.registry.waitForImage({ image });
      logs.push(`Found ${image}`);
    }

    // A newer deploy may have finished while this one waited. Check as late as
    // possible before mutating, so a slowed older deploy cannot overwrite the
    // newer revision: the Deployment's label records what is live, and a target
    // reachable from it is stale by definition.
    const deployed = await deps.kubectl.deployedSha({ namespace, deploymentName });
    if (deployed !== undefined) {
      const stale =
        deployed === commitSha || (await deps.git.isAncestor(directory, commitSha, deployed));
      if (stale) {
        logs.push(
          `Skipped ${commitSha}: deployment/${deploymentName} already runs ${deployed}, which is the same or newer`,
        );
        progress(`skipping ${commitSha}; ${deployed} is already deployed`);
        await deps.reporter.report({
          prUrl: null,
          logs: logs.join('\n'),
          commitSha,
          deployOutcome: 'skipped',
        });
        return { ok: true, prUrl: '', branch, commitSha };
      }
    }

    await deps.kubectl.applyServerSide({ directory, namespace, path: deployPath });
    logs.push(`Applied ${deployPath} with server-side apply`);

    // The manifest is authored at scaffold time and names a stable image, so
    // pin the Deployment to the exact image this merged commit built.
    await deps.kubectl.setImage({
      namespace,
      deploymentName,
      containerName: DEPLOY_CONTAINER_NAME,
      image,
    });
    logs.push(`Set deployment/${deploymentName} to ${image}`);

    // From here until the health check passes, a failure means the new
    // revision is live but broken, so the previous one must be restored.
    rollbackNeeded = true;
    await deps.kubectl.waitForRollout({ namespace, deploymentName });
    logs.push(`Rollout complete for deployment/${deploymentName}`);

    await deps.kubectl.checkHealth({ namespace, serviceName: deploymentName });
    rollbackNeeded = false;
    logs.push(`Health check passed for ${deploymentName}`);

    await deps.kubectl.labelDeployment({
      namespace,
      deploymentName,
      labelKey: DEPLOYED_SHA_LABEL,
      labelValue: commitSha,
    });
    logs.push(`Labelled deployment/${deploymentName} ${DEPLOYED_SHA_LABEL}=${commitSha}`);

    await deps.reporter.report({
      prUrl: null,
      logs: logs.join('\n'),
      commitSha,
      deployOutcome: 'success',
    });
    return { ok: true, prUrl: '', branch, commitSha };
  } catch (error) {
    logs.push(error instanceof Error ? error.message : String(error));

    if (rollbackNeeded) {
      // Capture the failing pods before rolling back: undo replaces them, and
      // the logs are what tells the Developer why the deploy broke.
      try {
        const podLogs = await deps.kubectl.podLogs({ namespace, deploymentName });
        if (podLogs.trim() !== '') logs.push(`Pod logs:\n${podLogs}`);
      } catch (cause) {
        logs.push(
          `Could not capture pod logs: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      try {
        const rollback = await deps.kubectl.undoRollout({ namespace, deploymentName });
        logs.push(
          rollback.rolledBack
            ? 'Rolled back to the previous revision'
            : `No previous revision to roll back${rollback.error === undefined ? '' : `: ${rollback.error}`}`,
        );
      } catch (cause) {
        logs.push(`Rollback failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    const output = logs.join('\n');
    await deps.reporter.report({ prUrl: null, logs: output, commitSha, deployOutcome: 'failed' });
    return {
      ok: false,
      reason: 'deploy-failed',
      output,
      branch,
    };
  }
}

/** Runs the attempt this Job was spawned for, dispatching on its kind. */
export async function runAgent(
  config: AgentConfig,
  deps: AgentDependencies,
): Promise<AgentOutcome> {
  if (config.kind === 'deploy') return runDeploy(config, deps);
  if (config.kind === 'resolve-conflicts') return runResolveConflicts(config, deps);
  return config.kind === 'review' ? runReview(config, deps) : runImplement(config, deps);
}
