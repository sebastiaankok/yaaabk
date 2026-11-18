import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { messageOf, templateError } from './errors';
import type { GitBackend, TemplateSource } from './git-backend';
import { copyTemplate } from './interpolate';

const exec = promisify(execFile);

/**
 * Builds a git credential helper that answers GitHub pushes from memory.
 *
 * The backend deploys as an image without a credential helper or SSH key, so
 * pushing the scaffold to an `https://github.com` remote needs the token fed
 * through git's credential protocol. The helper never touches disk (no
 * `git credential-store`), and `GIT_TERMINAL_PROMPT=0` keeps git from falling
 * back to an interactive prompt — without it the push dies with "could not
 * read Username for 'https://github.com': No such device or address" the
 * moment stdin is not a TTY. Returns `undefined` for remotes it should not
 * handle (non-https GitHub URLs, other hosts, empty token).
 */
export function installCredentialHelper(url: string, token: string): string | undefined {
  if (token === '') {
    return undefined;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname !== 'github.com' && !hostname.endsWith('.github.com')) {
    return undefined;
  }
  process.env.GIT_TERMINAL_PROMPT = '0';
  return `!f() { test "$1" = get && printf "username=x-access-token\\npassword=${token}\\n"; }; f`;
}

/** The remote URL without any embedded credentials, for `origin` and errors. */
export function unauthenticatedRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') {
      return `${parsed.protocol}//${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Appends a remediation hint to a push failure GitHub rejects for a missing
 * `workflows` permission.
 *
 * Every Project ships a `.github/workflows/ci.yml`, so the very first scaffold
 * push creates a workflow file. GitHub refuses that push when the authenticating
 * GitHub App was not granted the `workflows` permission, with a message that
 * names the permission but not how to grant it. Pass the rest of git's stderr
 * through untouched and only add the fix, so the Developer can act on it without
 * leaving the error.
 */
export function explainPushFailure(message: string): string {
  const missingWorkflows =
    /refusing to allow a GitHub App to create or update workflow/i.test(message) ||
    /without\s+`?workflows`?\s+permission/i.test(message);
  if (!missingWorkflows) {
    return message;
  }
  return (
    `${message}\n\n` +
    'The GitHub App is missing the Workflows permission. Grant "Workflows: Read and write" ' +
    'to the App under Settings → Permissions & events, then reinstall it on the owner account. ' +
    'YAAABK scaffolds a CI workflow, so every Project push needs it.'
  );
}

/**
 * Git variables that pin a command to a repository, removed from every child.
 *
 * Git exports `GIT_DIR` and `GIT_INDEX_FILE` to hooks. Inherited here they win
 * over `-C`, so a scaffold started from a git hook (the pre-commit suite runs
 * these tests) would commit into the caller's repository instead of the
 * directory the scaffold created — which is how a test run landed scaffold
 * commits on a developer's branch.
 */
const REPOSITORY_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
] as const;

/** The process environment without repository-pinning git variables. */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REPOSITORY_ENV_VARS) {
    delete env[name];
  }
  return env;
}

/** Runs `git` in `directory`, rejecting with the command's stderr on failure. */
async function git(directory: string, args: string[]): Promise<void> {
  try {
    await exec('git', ['-C', directory, ...args], { env: cleanGitEnv() });
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
        await exec('git', args, { env: cleanGitEnv() });
      } catch (error) {
        throw templateError('missing-template', gitMessage(error), error);
      }
    },

    async initRepository(directory) {
      await rm(join(directory, '.git'), { recursive: true, force: true });
      await exec('git', ['init', '-b', 'main', directory], { env: cleanGitEnv() });
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

    async push(directory, { url, branch, token }) {
      try {
        // `remote add` fails if origin exists (e.g. a re-run); make it idempotent.
        await git(directory, ['remote', 'remove', 'origin']).catch(() => {});
        await git(directory, ['remote', 'add', 'origin', unauthenticatedRepoUrl(url)]);
        const helper = token === undefined ? undefined : installCredentialHelper(url, token);
        const pushArgs = ['push', '--set-upstream', 'origin', branch];
        if (helper !== undefined) {
          // The helper authenticates the push; the remote itself stays
          // token-free so a misconfigured helper cannot leak the token into
          // `.git/config`.
          pushArgs.unshift('-c', `credential.helper=${helper}`);
        }
        await git(directory, pushArgs);
      } catch (error) {
        throw templateError('push-failed', explainPushFailure(gitMessage(error)), error);
      }
    },
  };
}
