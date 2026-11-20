/**
 * Renders the decision record committed to a Project repository when the
 * Developer accepts a Plan.
 *
 * Pure on purpose: the acceptance path supplies the facts, so the document
 * shape is tested without touching GitHub. Internal identifiers are
 * deliberately absent — Project repositories are public.
 */

/** The fields the accepted-Plan document needs. */
export interface AcceptedPlanDocument {
  /** The Plan's 1-based version. */
  version: number;
  /** The Project's repository name, e.g. `todo-app`. */
  projectName: string;
  /** The accepted Plan's Markdown, reproduced verbatim. */
  contentMarkdown: string;
  /** When the Developer accepted the Plan, as an ISO-8601 timestamp. */
  acceptedAt: string;
  /** The Issues published with this Plan, in publication order. */
  issues: AcceptedPlanIssue[];
}

/** One published Issue as the appendix lists it. */
export interface AcceptedPlanIssue {
  title: string;
  label: string;
  /** Titles of Issues that must be implemented first. */
  dependsOn: string[];
}

/** The date part of an ISO-8601 timestamp. */
function dateOf(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString().slice(0, 10);
}

/** One appendix line for a published Issue. */
function issueLine(issue: AcceptedPlanIssue): string {
  const line = `- **${issue.title}** (\`${issue.label}\`)`;
  return issue.dependsOn.length === 0
    ? line
    : `${line} — depends on: ${issue.dependsOn.join(', ')}`;
}

/** Renders the Markdown committed to `docs/plans/v<N>.md` on acceptance. */
export function renderAcceptedPlan(plan: AcceptedPlanDocument): string {
  return [
    '---',
    `version: ${plan.version}`,
    `accepted: ${dateOf(plan.acceptedAt)}`,
    '---',
    '',
    `# Plan v${plan.version} — ${plan.projectName}`,
    '',
    plan.contentMarkdown,
    '',
    '## Issues published with this Plan',
    '',
    ...plan.issues.map(issueLine),
  ].join('\n');
}
