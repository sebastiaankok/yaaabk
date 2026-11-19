/**
 * The Issue shape a Grill-Me Session agent reports through the reporting MCP
 * server. Shared so the server and the backend validate it identically.
 */

import { normaliseSummary } from './summary';

/** An issue as the agent reports it, before validation. */
export interface GeneratedIssueReport {
  title: string;
  body: string;
  /** One or two plain-English sentences; never part of the GitHub Issue body. */
  summary: string;
  labels: string[];
  depends_on: string[];
}

/** Whether the reported issue list is acceptable. */
export type GeneratedIssueReportResult =
  { ok: true; value: GeneratedIssueReport[] } | { ok: false; message: string };

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return [...value];
  }
  return undefined;
}

/**
 * Validates and normalises an agent-reported Issue list.
 *
 * Rejects the whole list when any entry is malformed, so a session never stores
 * a half-formed draft. Every issue needs a valid summary. Optional `body`,
 * `labels` and `depends_on` default to an empty value.
 */
export function normaliseGeneratedIssues(value: unknown): GeneratedIssueReportResult {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'Issues must be a list' };
  }

  const issues: GeneratedIssueReport[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, message: `Issue at index ${index} is not an object` };
    }
    const { title, body, summary, labels, depends_on: dependsOn } = item as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, message: `Issue at index ${index} is missing a title` };
    }
    const parsedSummary = normaliseSummary(summary);
    if (!parsedSummary.ok) {
      return { ok: false, message: `Issue "${title}" is missing a valid summary` };
    }
    const parsedLabels = stringArray(labels);
    if (parsedLabels === undefined) {
      return { ok: false, message: `Issue "${title}" has a non-string labels entry` };
    }
    const parsedDependencies = stringArray(dependsOn);
    if (parsedDependencies === undefined) {
      return { ok: false, message: `Issue "${title}" has a non-string depends_on entry` };
    }
    issues.push({
      title: title.trim(),
      body: typeof body === 'string' ? body : '',
      summary: parsedSummary.value,
      labels: parsedLabels,
      depends_on: parsedDependencies,
    });
  }
  return { ok: true, value: issues };
}
