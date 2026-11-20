import { describe, expect, it } from 'vitest';
import { createFakeGitHubContents } from './fake-github-contents';

describe('createFakeGitHubContents', () => {
  it('creates, then updates a file while counting commits', async () => {
    const contents = createFakeGitHubContents();
    const first = await contents.writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\n',
      message: 'first',
    });
    const second = await contents.writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\nChanged\n',
      message: 'second',
    });

    expect(first.ok && first.value.status).toBe('created');
    expect(second.ok && second.value.status).toBe('updated');
    expect(contents.commits('acme/todo-app')).toBe(2);
    expect(contents.files('acme/todo-app')).toEqual([
      { path: 'docs/plans/v1.md', content: '# Plan v1\nChanged\n' },
    ]);
  });

  it('makes no commit for identical content', async () => {
    const contents = createFakeGitHubContents();

    await contents.writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\n',
      message: 'first',
    });
    const again = await contents.writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\n',
      message: 'retry',
    });

    expect(again.ok && again.value.status).toBe('unchanged');
    expect(contents.commits('acme/todo-app')).toBe(1);
  });

  it('surfaces a queued failure', async () => {
    const contents = createFakeGitHubContents();
    const error = { kind: 'unauthorized' as const, operation: 'write-file', message: 'nope' };
    contents.failNext('write-file', error);

    const result = await contents.writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\n',
      message: 'first',
    });

    expect(result).toEqual({ ok: false, error });
    expect(contents.files('acme/todo-app')).toEqual([]);
  });
});
