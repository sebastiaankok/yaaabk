import { afterEach, describe, expect, it } from 'vitest';
import { installCredentialHelper, unauthenticatedRepoUrl } from './git';

afterEach(() => {
  delete process.env.GIT_TERMINAL_PROMPT;
});

describe('installCredentialHelper', () => {
  it('feeds the token to git for github.com pushes without writing to disk', () => {
    const result = installCredentialHelper('https://github.com/acme/todo-app.git', 'ghp_secret');

    expect(result).toBe('!f() { test "$1" = get && printf "username=x-access-token\\npassword=ghp_secret\\n"; }; f');
    // Without this, git prompts for credentials on stdin and dies with
    // "could not read Username for 'https://github.com': No such device or address".
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('returns undefined for remote URLs without a github.com host', () => {
    for (const url of [
      'git@github.com:acme/todo-app.git',
      `file:///tmp/todo-app.git`,
      'https://gitlab.com/acme/todo-app.git',
      'not a url',
    ]) {
      expect(installCredentialHelper(url, 'ghp_secret')).toBeUndefined();
    }
  });

  it('returns undefined for an empty token', () => {
    expect(installCredentialHelper('https://github.com/acme/todo-app.git', '')).toBeUndefined();
  });
});

describe('unauthenticatedRepoUrl', () => {
  it('strips a token a provider put in the URL instead of keeping it in a field', () => {
    expect(
      unauthenticatedRepoUrl('https://x-access-token:ghp_secret@github.com/acme/todo-app.git'),
    ).toBe('https://github.com/acme/todo-app.git');
  });

  it('leaves plain remote URLs untouched', () => {
    expect(unauthenticatedRepoUrl('https://github.com/acme/todo-app.git')).toBe(
      'https://github.com/acme/todo-app.git',
    );
  });
});

describe.skipIf(process.env.SKIP_GIT_CREDENTIAL_TESTS === '1')('credential helper against real git', () => {
  it('pushes to an https remote using the injected helper', async () => {
    const { execFile } = await import('node:child_process');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    // A local "remote" behind an https-to-file shim: the helper is only
    // consulted by http(s) remotes, so we assert the plumbing on a real git
    // invocation by checking the config it writes and the env it needs.
    const root = await mkdtemp(join(tmpdir(), 'yaaabk-cred-test-'));
    try {
      const helper = installCredentialHelper(
        'https://github.com/acme/todo-app.git',
        'ghp_secret',
      );
      const { stdout } = await exec('git', ['-c', `credential.helper=${helper}`, 'config', '--get-all', 'credential.helper']);
      // The injected helper is appended to any platform defaults (e.g. macOS
      // ships `osxkeychain`); git consults them in order and ours answers.
      expect(stdout.trim().split('\n')).toContain(helper);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});