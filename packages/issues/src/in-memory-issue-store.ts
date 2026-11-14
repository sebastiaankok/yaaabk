import { issuesError } from './errors';
import type { Issue, IssueStore } from './types';

/** Oldest first, with id breaking ties within the same creation instant. */
function byOldestFirst(a: Issue, b: Issue): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Returns whether another Issue in the same Project already uses `title`. */
function titleTaken(issues: Map<string, Issue>, issue: Issue): boolean {
  for (const existing of issues.values()) {
    if (
      existing.projectId === issue.projectId &&
      existing.id !== issue.id &&
      existing.title === issue.title
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A dependency-free {@link IssueStore} for tests and for other modules that
 * need the Issues Module without a database file.
 */
export function createInMemoryIssueStore(): IssueStore {
  const issues = new Map<string, Issue>();

  function assertTitleFree(issue: Issue): void {
    if (titleTaken(issues, issue)) {
      throw issuesError(
        'duplicate-title',
        `Issue "${issue.title}" already exists for project "${issue.projectId}"`,
      );
    }
  }

  return {
    create(issue) {
      assertTitleFree(issue);
      issues.set(issue.id, { ...issue, dependsOn: [...issue.dependsOn] });
    },

    get(projectId, issueId) {
      const issue = issues.get(issueId);
      return issue !== undefined && issue.projectId === projectId
        ? { ...issue, dependsOn: [...issue.dependsOn] }
        : undefined;
    },

    list(projectId) {
      return [...issues.values()]
        .filter((issue) => issue.projectId === projectId)
        .map((issue) => ({ ...issue, dependsOn: [...issue.dependsOn] }))
        .sort(byOldestFirst);
    },

    update(issue) {
      const existing = issues.get(issue.id);
      if (existing === undefined || existing.projectId !== issue.projectId) {
        throw issuesError(
          'not-found',
          `No issue with id "${issue.id}" for project "${issue.projectId}"`,
        );
      }
      assertTitleFree(issue);
      issues.set(issue.id, { ...issue, dependsOn: [...issue.dependsOn] });
    },

    delete(projectId, issueId) {
      const existing = issues.get(issueId);
      if (existing === undefined || existing.projectId !== projectId) {
        throw issuesError('not-found', `No issue with id "${issueId}" for project "${projectId}"`);
      }
      issues.delete(issueId);
    },
  };
}
