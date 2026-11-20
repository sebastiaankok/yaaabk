import type { GitHubResult } from './types';

/**
 * Public types for the repository-contents side of the GitHub integration.
 *
 * YAAABK commits an accepted Plan into its Project repository. The
 * `GitHubContents` port is deliberately narrow — read one file and write one
 * file on the default branch — so callers stay testable without a network.
 */

/** A file read from a repository, already decoded to text. */
export interface GitHubFile {
  path: string;
  /** The blob SHA, which an update must send back to GitHub. */
  sha: string;
  content: string;
}

/** The values needed to create or update a file. */
export interface WriteGitHubFileInput {
  /** The full file contents, as UTF-8 text. */
  content: string;
  /** The commit message. */
  message: string;
}

/** What a write actually did. */
export type GitHubFileWriteStatus = 'created' | 'updated' | 'unchanged';

/** The outcome of a create-or-update request. */
export interface GitHubFileWrite {
  status: GitHubFileWriteStatus;
  /**
   * The file's blob SHA after the write. `null` when GitHub did not return one.
   */
  sha: string | null;
}

/**
 * The port the accepted-Plan recorder runs through.
 *
 * Writes target the repository's default branch: no branch is sent, so GitHub
 * applies its own default. An identical write is a no-op, making acceptance
 * retries idempotent.
 */
export interface GitHubContents {
  /** Reads one file, or `null` when it does not exist. */
  readFile(repo: string, path: string): Promise<GitHubResult<GitHubFile | null>>;
  /**
   * Creates the file, or updates it when its content differs. An identical
   * content makes no commit and reports `unchanged`.
   */
  writeFile(
    repo: string,
    path: string,
    input: WriteGitHubFileInput,
  ): Promise<GitHubResult<GitHubFileWrite>>;
}
