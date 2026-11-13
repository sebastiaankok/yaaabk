/**
 * The Repository port the Projects Module creates repositories through.
 *
 * Creating a Project needs a backing git repository before the template can be
 * pushed. GitHub is the first implementation, but the module only depends on
 * this narrow, two-verb contract, so tests inject a fake and a future GitLab
 * adapter slots in without touching the module.
 */

/** The kinds of failure a repository operation can report. */
export type RepositoryErrorKind =
  'invalid-input' | 'already-exists' | 'unauthorized' | 'not-found' | 'network' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface RepositoryError {
  kind: RepositoryErrorKind;
  /** The operation that failed, e.g. `create`. */
  operation: string;
  message: string;
  /** HTTP status from the provider, when the failure came from a response. */
  statusCode?: number;
}

/** The result of a repository operation: either a value or a typed error. */
export type RepositoryResult<T> = { ok: true; value: T } | { ok: false; error: RepositoryError };

/** A repository the provider created or resolved. */
export interface Repository {
  /** Full name, e.g. `acme/todo-app`. */
  fullName: string;
  /**
   * Git URL the scaffolder pushes to. May embed credentials (e.g. an
   * installation token), so it is never rendered in the UI.
   */
  cloneUrl: string;
  /** Browser URL, safe to show and link. */
  url: string;
}

export interface CreateRepositoryInput {
  /** Repository name, matching the Project name. */
  name: string;
  description: string;
  /** Whether the repository is private. Defaults to true. */
  private?: boolean;
}

/** The Repository port's public contract. */
export interface RepositoryProvider {
  create(input: CreateRepositoryInput): Promise<RepositoryResult<Repository>>;
  /** Deletes the repository, or fails. Callers treat `not-found` as success. */
  delete(fullName: string): Promise<RepositoryResult<void>>;
}
