import type { Issue } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';

/** Where a Plan is in its lifecycle, derived from acceptance and its Issues. */
export type PlanLifecycleStatus = 'not-accepted' | 'in-progress' | 'completed';

/** A Plan's lifecycle status together with the counts the review list shows. */
export interface PlanProgress {
  status: PlanLifecycleStatus;
  /** Issues the Plan owns, closed ones included. */
  total: number;
  closed: number;
  failed: number;
}

/**
 * Summarises one Plan version.
 *
 * Completion is derived, never stored: a Plan is Completed only when it was
 * accepted, has at least one Issue, and every one of its Issues is closed.
 * An accepted Plan with no Issues yet is still in progress.
 */
export function planProgress(plan: Plan, issues: Issue[]): PlanProgress {
  const own = issues.filter((issue) => issue.planId === plan.id);
  const closed = own.filter((issue) => issue.status === 'closed').length;
  const failed = own.filter((issue) => issue.status === 'failed').length;
  const status: PlanLifecycleStatus =
    plan.acceptedAt === null
      ? 'not-accepted'
      : own.length > 0 && closed === own.length
        ? 'completed'
        : 'in-progress';
  return { status, total: own.length, closed, failed };
}

/** The label the UI shows for a lifecycle status. */
export function planStatusLabel(status: PlanLifecycleStatus): string {
  switch (status) {
    case 'not-accepted':
      return 'Not accepted';
    case 'in-progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
  }
}

/**
 * Whether an accepted Plan has Issues that never reached GitHub.
 *
 * Those need the small `Retry GitHub sync` action; an unaccepted Plan has none
 * yet because accepting performs the first push.
 */
export function pendingGithubSync(plan: Plan, issues: Issue[]): boolean {
  return (
    plan.acceptedAt !== null &&
    issues.some((issue) => issue.planId === plan.id && issue.githubNumber === null)
  );
}
