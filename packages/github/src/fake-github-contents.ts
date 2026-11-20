import type { GitHubContents, GitHubFile, GitHubFileWrite, WriteGitHubFileInput } from './contents';
import type { GitHubError, GitHubResult } from './types';

/** The operations a fake can be told to fail. */
export type FakeGitHubContentsOperation = 'read-file' | 'write-file';

/** One recorded call, for assertions. */
export interface FakeGitHubContentsCall {
  operation: FakeGitHubContentsOperation;
  repo: string;
  path: string;
  input?: WriteGitHubFileInput;
}

interface QueuedFailure {
  operation: FakeGitHubContentsOperation;
  error: GitHubError;
}

interface StoredFile {
  sha: string;
  content: string;
}

export interface FakeGitHubContents extends GitHubContents {
  /** Every call made, in order. */
  readonly calls: FakeGitHubContentsCall[];
  /** The files on a repository, path and decoded content. */
  files(repo: string): Array<{ path: string; content: string }>;
  /** How many commits the writes made; identical content adds none. */
  commits(repo: string): number;
  /** Puts a file in the repository without recording a commit. */
  setFile(repo: string, path: string, content: string): void;
  /** Makes the next call to `operation` fail with `error`. */
  failNext(operation: FakeGitHubContentsOperation, error: GitHubError): void;
}

/**
 * An in-memory {@link GitHubContents} for tests.
 *
 * It behaves like the contents API for the operations recording a Plan needs —
 * reading, creating, and updating with the current SHA — including the
 * no-commit-when-identical rule, and exposes hooks to inject failures.
 */
export function createFakeGitHubContents(): FakeGitHubContents {
  const filesByRepo = new Map<string, Map<string, StoredFile>>();
  const commitsByRepo = new Map<string, number>();
  const calls: FakeGitHubContentsCall[] = [];
  const failures: QueuedFailure[] = [];
  let nextSha = 1;

  function repoFiles(repo: string): Map<string, StoredFile> {
    let files = filesByRepo.get(repo);
    if (files === undefined) {
      files = new Map();
      filesByRepo.set(repo, files);
    }
    return files;
  }

  function takeFailure(operation: FakeGitHubContentsOperation): GitHubError | undefined {
    const index = failures.findIndex((failure) => failure.operation === operation);
    if (index === -1) return undefined;
    return failures.splice(index, 1)[0]?.error;
  }

  function fail<T>(operation: FakeGitHubContentsOperation): GitHubResult<T> | undefined {
    const error = takeFailure(operation);
    return error === undefined ? undefined : { ok: false, error };
  }

  function newSha(): string {
    return `blob-${nextSha++}`;
  }

  return {
    calls,
    files(repo) {
      return [...repoFiles(repo)].map(([path, file]) => ({ path, content: file.content }));
    },
    commits(repo) {
      return commitsByRepo.get(repo) ?? 0;
    },
    setFile(repo, path, content) {
      repoFiles(repo).set(path, { sha: newSha(), content });
    },
    failNext(operation, error) {
      failures.push({ operation, error });
    },

    async readFile(repo, path) {
      calls.push({ operation: 'read-file', repo, path });
      const failed = fail<GitHubFile | null>('read-file');
      if (failed !== undefined) return failed;
      const file = repoFiles(repo).get(path);
      return {
        ok: true,
        value: file === undefined ? null : { path, sha: file.sha, content: file.content },
      };
    },

    async writeFile(repo, path, input) {
      calls.push({ operation: 'write-file', repo, path, input });
      const failed = fail<GitHubFileWrite>('write-file');
      if (failed !== undefined) return failed;

      const files = repoFiles(repo);
      const existing = files.get(path);
      if (existing !== undefined && existing.content === input.content) {
        return { ok: true, value: { status: 'unchanged', sha: existing.sha } };
      }
      const sha = newSha();
      files.set(path, { sha, content: input.content });
      commitsByRepo.set(repo, (commitsByRepo.get(repo) ?? 0) + 1);
      return {
        ok: true,
        value: { status: existing === undefined ? 'created' : 'updated', sha },
      };
    },
  };
}
