import type { AgentManager } from '@yaaabk/agents';
import type { GitHubIssues, GitHubMergeMethod, GitHubPulls } from '@yaaabk/github';
import type { Issue, IssuesModule } from '@yaaabk/issues';
import type { Project, ProjectStore } from '@yaaabk/projects';
import { issueNumberFromBranch } from '@yaaabk/shared';
import {
  AUTOMERGE_LABEL,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  isValidInterval,
} from './config';
import { decideAction, type ReviewVerdict } from './decide-action';
import { consoleLogger, toCiError, type CiTrackerLogger } from './errors';
import type {
  CiPollSummary,
  CiTracker,
  CiTrackerConfigPatch,
  CiTrackerResult,
  CiTrackerStatus,
  CiTimers,
  PullRequestWatch,
  WatchAction,
} from './types';

export interface CiTrackerOptions {
  /** Resolves every Project and its repository. */
  projects: ProjectStore;
  /** Reads and updates the Issues the watched pull requests implement. */
  issues: IssuesModule;
  /** Spawns fix attempts on a failing pull request. */
  agents: AgentManager;
  /** Lists pull requests, reads their check state and merges them. */
  pulls: GitHubPulls;
  /** Closes the GitHub Issue once its pull request is merged. */
  githubIssues: GitHubIssues;
  /** Milliseconds between passes. Defaults to 30s. */
  intervalMs?: number;
  /** Whether the loop runs. Defaults to `true`. */
  enabled?: boolean;
  /** Merge strategy for a passing pull request. Defaults to the repository's own. */
  mergeMethod?: GitHubMergeMethod;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable scheduler, so tests can drive the loop without real time. */
  timers?: CiTimers;
  logger?: CiTrackerLogger;
}

const DEFAULT_TIMERS: CiTimers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Builds the CI Tracker.
 *
 * Each pass walks every Project, lists the pull requests labelled `automerge`,
 * and reacts to the check state and review verdict of each head commit. Green
 * checks with no review spawn a review Agent; green checks with an approval
 * merge the pull request and close its Issue. A request-changes verdict spawns a
 * fix attempt carrying the reviewer's summary until the rejection threshold or
 * the Issue's attempt budget is spent, after which it is labelled `needs-human`.
 * Failing checks spawn a fix attempt under the same budget. The head commit is
 * remembered, so a still-failing pull request is not fixed twice, and a review
 * verdict is keyed to the commit it was made against.
 */
export function createCiTracker(options: CiTrackerOptions): CiTracker {
  const { projects, issues, agents, pulls, githubIssues } = options;
  const logger = options.logger ?? consoleLogger;
  const now = options.clock ?? (() => new Date());
  const timers = options.timers ?? DEFAULT_TIMERS;

  let enabled = options.enabled ?? true;
  let intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let lastCheckedAt: string | null = null;
  let handle: unknown = null;
  let inFlight = false;
  const watches = new Map<string, PullRequestWatch>();

  function nowIso(): string {
    return now().toISOString();
  }

  function watchKey(projectId: string, pullNumber: number): string {
    return `${projectId}#${pullNumber}`;
  }

  /** The Issue a pull request implements, resolved from its head branch. */
  async function resolveIssue(projectId: string, headRef: string): Promise<Issue | undefined> {
    const number = issueNumberFromBranch(headRef);
    if (number === null) return undefined;
    const listed = await issues.list(projectId);
    if (!listed.ok) return undefined;
    return listed.value.find((issue) => issue.githubNumber === number);
  }

  /** Merges a pull request and closes its Issue, locally and on GitHub. */
  async function mergeAndClose(
    project: Project,
    issue: Issue,
    pullNumber: number,
  ): Promise<boolean> {
    const input = options.mergeMethod === undefined ? {} : { method: options.mergeMethod };
    const merged = await pulls.mergePullRequest(project.repoFullName, pullNumber, input);
    if (!merged.ok) {
      logger.error('ci merge failed', {
        projectId: project.id,
        pull: pullNumber,
        kind: merged.error.kind,
      });
      return false;
    }
    const updated = await issues.update(project.id, issue.id, {
      status: 'closed',
      closedAt: nowIso(),
    });
    if (!updated.ok) {
      logger.error('ci close failed', { projectId: project.id, issueId: issue.id });
      return false;
    }
    if (issue.githubNumber !== null) {
      const closed = await githubIssues.updateIssue(project.repoFullName, issue.githubNumber, {
        state: 'closed',
      });
      if (!closed.ok) {
        logger.error('ci github close failed', {
          projectId: project.id,
          issue: issue.githubNumber,
          kind: closed.error.kind,
        });
      }
    }
    return true;
  }

  /** Spawns a fix attempt on the pull request branch, carrying reviewer feedback. */
  async function spawnFix(
    project: Project,
    issue: Issue,
    headRef: string,
    reviewFeedback: string | null,
  ): Promise<boolean> {
    const spawned = await agents.spawn(project.id, issue.id, {
      branch: headRef,
      ...(reviewFeedback === null || reviewFeedback.trim() === '' ? {} : { reviewFeedback }),
    });
    if (!spawned.ok) {
      logger.error('ci spawn fix failed', {
        projectId: project.id,
        issueId: issue.id,
        kind: spawned.error.kind,
      });
      return false;
    }
    logger.info('ci spawned fix', { projectId: project.id, issueId: issue.id, branch: headRef });
    return true;
  }

  /** Escalates an Issue to a human. */
  async function escalate(project: Project, issue: Issue): Promise<void> {
    await issues.update(project.id, issue.id, { label: 'needs-human' });
    logger.info('ci escalated to human', { projectId: project.id, issueId: issue.id });
  }

  /**
   * The latest review, but only when it was made against `headSha`.
   *
   * Returns `ok: false` when the reviews could not be read, so the caller can
   * leave the watch untouched and retry on the next pass.
   */
  async function latestReviewForHead(
    project: Project,
    pullNumber: number,
    headSha: string,
  ): Promise<
    { ok: false } | { ok: true; review: { event: ReviewVerdict; body: string; id: number } | null }
  > {
    const listed = await pulls.listReviews(project.repoFullName, pullNumber);
    if (!listed.ok) {
      logger.error('ci list-reviews failed', {
        projectId: project.id,
        pull: pullNumber,
        kind: listed.error.kind,
      });
      return { ok: false };
    }
    const latest = listed.value[listed.value.length - 1];
    if (latest === undefined || latest.commitId !== headSha) return { ok: true, review: null };
    const event: ReviewVerdict =
      latest.event === 'approve'
        ? 'approve'
        : latest.event === 'request-changes'
          ? 'request-changes'
          : 'none';
    return { ok: true, review: { event, body: latest.body, id: latest.id } };
  }

  async function poll(): Promise<CiTrackerResult<CiPollSummary>> {
    try {
      const summary: CiPollSummary = {
        projects: 0,
        pulls: 0,
        pending: 0,
        merged: 0,
        reviewSpawned: 0,
        fixSpawned: 0,
        needsHuman: 0,
      };
      if (!enabled) return { ok: true, value: summary };

      for (const project of projects.list()) {
        summary.projects += 1;
        const listed = await pulls.listPullRequests(project.repoFullName, [AUTOMERGE_LABEL]);
        if (!listed.ok) {
          logger.error('ci list-pulls failed', {
            projectId: project.id,
            kind: listed.error.kind,
          });
          continue;
        }

        for (const pull of listed.value) {
          summary.pulls += 1;
          const issue = await resolveIssue(project.id, pull.headRef);
          if (issue === undefined) {
            logger.info('ci skip unmatched pull', {
              projectId: project.id,
              pull: pull.number,
              headRef: pull.headRef,
            });
            continue;
          }
          const checked = await pulls.checkState(project.repoFullName, pull.headSha);
          if (!checked.ok) {
            logger.error('ci check-state failed', {
              projectId: project.id,
              pull: pull.number,
              kind: checked.error.kind,
            });
            continue;
          }

          const key = watchKey(project.id, pull.number);
          const previous = watches.get(key);
          const sameHead = previous !== undefined && previous.headSha === pull.headSha;
          const action: WatchAction | null = sameHead ? previous.action : null;
          const watch: PullRequestWatch = {
            projectId: project.id,
            repoFullName: project.repoFullName,
            pullNumber: pull.number,
            headRef: pull.headRef,
            headSha: pull.headSha,
            issueId: issue.id,
            state: checked.value.state,
            action,
            rejections: previous?.rejections ?? 0,
            lastReviewId: previous?.lastReviewId ?? null,
            lastCheckedAt: nowIso(),
          };

          if (checked.value.state === 'pending') {
            watches.set(key, watch);
            summary.pending += 1;
            continue;
          }
          if (pull.draft) {
            watches.set(key, watch);
            continue;
          }

          // Only green checks are judged by a review; a verdict is valid only
          // for the head commit it was made against.
          let verdict: ReviewVerdict = 'none';
          let reviewBody: string | null = null;
          if (checked.value.state === 'success') {
            const latest = await latestReviewForHead(project, pull.number, pull.headSha);
            if (!latest.ok) continue;
            if (latest.review !== null) {
              verdict = latest.review.event;
              reviewBody = latest.review.body;
              if (latest.review.id !== watch.lastReviewId) {
                if (latest.review.event === 'request-changes') watch.rejections += 1;
                watch.lastReviewId = latest.review.id;
              }
            }
          }
          watches.set(key, watch);

          const decision = decideAction(
            checked.value.state,
            verdict,
            watch.rejections,
            issue.attemptCount,
            issue.maxAttempts,
          );
          if (action === 'merged' || action === 'needs-human') continue;

          switch (decision) {
            case 'wait':
              break;
            case 'spawn-review':
              if (action === 'review-spawned') break;
              {
                const spawned = await agents.spawn(project.id, issue.id, {
                  kind: 'review',
                  pullNumber: pull.number,
                  branch: pull.headRef,
                });
                if (!spawned.ok) {
                  logger.error('ci spawn review failed', {
                    projectId: project.id,
                    issueId: issue.id,
                    pull: pull.number,
                    kind: spawned.error.kind,
                  });
                  break;
                }
                watches.set(key, { ...watch, action: 'review-spawned' });
                summary.reviewSpawned += 1;
                logger.info('ci spawned review', {
                  projectId: project.id,
                  issueId: issue.id,
                  pull: pull.number,
                });
              }
              break;
            case 'merge':
              if (await mergeAndClose(project, issue, pull.number)) {
                watches.set(key, { ...watch, action: 'merged' });
                summary.merged += 1;
              }
              break;
            case 'fix':
              if (action === 'fix-spawned') break;
              if (await spawnFix(project, issue, pull.headRef, reviewBody)) {
                watches.set(key, { ...watch, action: 'fix-spawned' });
                summary.fixSpawned += 1;
              }
              break;
            case 'escalate':
              await escalate(project, issue);
              watches.set(key, { ...watch, action: 'needs-human' });
              summary.needsHuman += 1;
              break;
          }
        }
      }

      lastCheckedAt = nowIso();
      return { ok: true, value: summary };
    } catch (error) {
      const mapped = toCiError('poll', error);
      logger.error('ci poll failed', { kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  function status(): CiTrackerStatus {
    return {
      enabled,
      intervalMs,
      lastCheckedAt,
      watches: [...watches.values()],
    };
  }

  function start(): void {
    if (!enabled || handle !== null) return;
    handle = timers.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void poll().finally(() => {
        inFlight = false;
      });
    }, intervalMs);
  }

  function stop(): void {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  }

  return {
    poll,

    status,

    configure(patch: CiTrackerConfigPatch): CiTrackerResult<CiTrackerStatus> {
      if (patch.intervalMs !== undefined && !isValidInterval(patch.intervalMs)) {
        return {
          ok: false,
          error: {
            kind: 'invalid-input',
            operation: 'configure',
            message: `intervalMs must be an integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS}`,
          },
        };
      }
      stop();
      if (patch.enabled !== undefined) enabled = patch.enabled;
      if (patch.intervalMs !== undefined) intervalMs = patch.intervalMs;
      start();
      return { ok: true, value: status() };
    },

    start,
    stop,
  };
}
