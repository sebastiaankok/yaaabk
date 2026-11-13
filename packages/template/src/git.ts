import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { messageOf, templateError } from './errors';
import type { GitBackend, TemplateSource } from './git-backend';
import { copyTemplate } from './interpolate';

const exec = promisify(execFile);

/** Runs `git` in `directory`, rejecting with the command's stderr on failure. */
async function git(directory: string, args: string[]): Promise<void> {
  try {
    await exec('git', ['-C', directory, ...args]);
  } catch (error) {
    throw new Error(gitMessage(error), { cause: error });
  }
}

function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') {
    return stderr.trim();
  }
  return messageOf(error);
}

/**
 * The real {@link GitBackend}, shelling out to the `git` binary.
 *
 * Template fetches are the only network-touching step and are classified as
 * `missing-template`; pushes are classified as `push-failed`. Everything else
 * surfaces as `unknown` via the module's error mapping.
 */
export function createGitBackend(): GitBackend {
  return {
    async fetchTemplate(source: TemplateSource, directory) {
      try {
        if (source.type === 'directory') {
          await copyTemplate(source.path, directory);
          return;
        }
        const args = ['clone', '--depth', '1'];
        if (source.ref !== undefined) {
          args.push('--branch', source.ref);
        }
        args.push(source.url, directory);
        await exec('git', args);
      } catch (error) {
        throw templateError('missing-template', gitMessage(error), error);
      }
    },

    async initRepository(directory) {
      await rm(join(directory, '.git'), { recursive: true, force: true });
      await exec('git', ['init', '-b', 'main', directory]);
    },

    async commitAll(directory, { message, author }) {
      await git(directory, ['add', '--all']);
      await git(directory, [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '--message',
        message,
      ]);
    },

    async push(directory, { url, branch }) {
      try {
        // `remote add` fails if origin exists (e.g. a re-run); make it idempotent.
        await git(directory, ['remote', 'remove', 'origin']).catch(() => {});
        await git(directory, ['remote', 'add', 'origin', url]);
        await git(directory, ['push', '--set-upstream', 'origin', branch]);
      } catch (error) {
        throw templateError('push-failed', gitMessage(error), error);
      }
    },
  };
}
