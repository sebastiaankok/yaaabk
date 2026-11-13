import { existsSync } from 'node:fs';
import { copyTemplate } from './interpolate';
import { templateError } from './errors';
import type { GitAuthor, GitBackend, TemplateSource } from './git-backend';

/** A recorded call to a {@link GitBackend} method. */
export type GitOperation =
  | { op: 'fetch'; source: TemplateSource; directory: string }
  | { op: 'init'; directory: string }
  | { op: 'commit'; directory: string; message: string; author: GitAuthor }
  | { op: 'push'; directory: string; url: string; branch: string };

export interface FakeGitBackendOptions {
  /** Template directories keyed by git URL, used when a `git` source is fetched. */
  templates?: Record<string, string>;
  /** Fail every push with this message, simulating a rejected/unauthorised push. */
  pushError?: string;
}

/** A {@link GitBackend} that records its calls and touches no remote, for tests. */
export interface FakeGitBackend extends GitBackend {
  /** Every call made, in order. */
  readonly calls: GitOperation[];
}

function describeSource(source: TemplateSource): string {
  return source.type === 'directory' ? source.path : source.url;
}

/**
 * Builds a Git Backend for tests.
 *
 * `git`-sourced fetches copy the directory registered in `templates` (or fail
 * with `missing-template` when there is none), so richer end-to-end coverage
 * needs no network. Configure `pushError` to exercise the push-failure path.
 */
export function createFakeGitBackend(options: FakeGitBackendOptions = {}): FakeGitBackend {
  const calls: GitOperation[] = [];

  return {
    calls,

    async fetchTemplate(source, directory) {
      calls.push({ op: 'fetch', source, directory });
      const origin = source.type === 'directory' ? source.path : options.templates?.[source.url];
      if (origin === undefined || !existsSync(origin)) {
        throw templateError(
          'missing-template',
          `Template ${describeSource(source)} could not be found`,
        );
      }
      await copyTemplate(origin, directory);
    },

    async initRepository(directory) {
      calls.push({ op: 'init', directory });
    },

    async commitAll(directory, { message, author }) {
      calls.push({ op: 'commit', directory, message, author });
    },

    async push(directory, { url, branch }) {
      calls.push({ op: 'push', directory, url, branch });
      if (options.pushError !== undefined) {
        throw templateError('push-failed', options.pushError);
      }
    },
  };
}
