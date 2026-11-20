/** Branch the accepted Plan record is committed to, matching the Project scaffold. */
const DEFAULT_BRANCH = 'main';

/**
 * The repository path of an accepted Plan's decision record, e.g.
 * `docs/plans/v2.md`.
 *
 * Acceptance commits the document there; the Plan page links to it so the
 * Developer can read the durable record.
 */
export function planFilePath(version: number): string {
  return `docs/plans/v${version}.md`;
}

/** The GitHub blob URL for an accepted Plan's decision record. */
export function planFileUrl(repoFullName: string, version: number): string {
  return `https://github.com/${repoFullName}/blob/${DEFAULT_BRANCH}/${planFilePath(version)}`;
}
