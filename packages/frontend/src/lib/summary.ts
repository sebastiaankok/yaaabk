import type { Issue } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';
import { SUMMARY_MAX_LENGTH, deriveSummary, normaliseSummary } from '@yaaabk/shared';

export { SUMMARY_MAX_LENGTH };

/** The Summary a Plan row should show, deriving one for rows from before summaries. */
export function summaryForPlan(plan: Pick<Plan, 'summary' | 'contentMarkdown'>): string {
  return plan.summary ?? (deriveSummary(plan.contentMarkdown) || 'No summary yet.');
}

/** The Summary an Issue row should show, deriving one for rows from before summaries. */
export function summaryForIssue(issue: Pick<Issue, 'summary' | 'title' | 'body'>): string {
  return (
    issue.summary ?? (deriveSummary(issue.body) || deriveSummary(issue.title) || 'No summary yet.')
  );
}

/** Validates a summary typed into the Issue form, returning the value to save. */
export function validateSummary(value: string): { value: string } | { error: string } {
  const summary = normaliseSummary(value);
  return summary.ok ? { value: summary.value } : { error: summary.message };
}
