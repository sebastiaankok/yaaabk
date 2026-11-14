import type { IssueSyncStatus, PushSummary } from '@yaaabk/github';

/**
 * A one-line summary of how much of a Project's Issue set is mirrored on GitHub,
 * shown beside the "Sync with GitHub" action.
 */
export function describeSyncStatus(status: IssueSyncStatus): string {
  if (status.total === 0) {
    return 'No issues yet.';
  }
  if (status.synced === 0) {
    return `Not yet on GitHub · ${status.total} pending`;
  }
  if (status.pending === 0) {
    return `All ${status.total} issues on GitHub`;
  }
  return `${status.synced} of ${status.total} on GitHub · ${status.pending} pending`;
}

/** A one-line summary of what a push created and updated. */
export function describePush(summary: PushSummary): string {
  const parts: string[] = [];
  if (summary.created > 0) parts.push(`${summary.created} created`);
  if (summary.updated > 0) parts.push(`${summary.updated} updated`);
  if (parts.length === 0) return 'Everything already up to date.';
  return `GitHub in sync · ${parts.join(', ')}`;
}
