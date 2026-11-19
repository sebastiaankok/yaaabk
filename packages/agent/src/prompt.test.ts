import { describe, expect, it } from 'vitest';
import type { AgentConfig } from './config';
import type { AgentIssue } from './ports';
import { buildImplementPrompt, buildResolveConflictsPrompt } from './prompt';

const ISSUE: AgentIssue = { number: 42, title: 'Add login', body: 'With OAuth.' };

const CONFIG: AgentConfig = {
  kind: 'implement-issue',
  issueNumber: 42,
  repoUrl: 'https://github.com/acme/todo-app',
  githubToken: 'gh-token',
  openrouterApiKey: 'sk-or-key',
  maxAttempts: 3,
};

describe('buildImplementPrompt', () => {
  it('includes the Issue body', () => {
    const prompt = buildImplementPrompt(ISSUE, CONFIG);

    expect(prompt).toContain('Issue body:');
    expect(prompt).toContain('With OAuth.');
  });

  it('renders reviewer feedback as a distinct section', () => {
    const prompt = buildImplementPrompt(ISSUE, {
      ...CONFIG,
      branch: 'agent/issue-42',
      reviewFeedback: 'Please rename the helper in src/helper.ts.',
    });

    expect(prompt).toContain('A previous attempt was rejected.');
    expect(prompt).toContain('Reviewer feedback:');
    expect(prompt).toContain('Please rename the helper in src/helper.ts.');
  });

  it('leaves the Issue body untouched when feedback is present', () => {
    const prompt = buildImplementPrompt(ISSUE, {
      ...CONFIG,
      reviewFeedback: 'Please rename the helper.',
    });

    expect(prompt).toContain('Issue body:');
    expect(prompt).toContain('With OAuth.');
  });

  it('omits the feedback section when there is none', () => {
    const prompt = buildImplementPrompt(ISSUE, CONFIG);

    expect(prompt).not.toContain('Reviewer feedback:');
    expect(prompt).not.toContain('A previous attempt was rejected.');
  });

  it('includes Kubernetes debugging instructions using the mounted ServiceAccount token', () => {
    const prompt = buildImplementPrompt(ISSUE, CONFIG);

    expect(prompt).toContain('kubectl');
    expect(prompt).toContain('yaaabk-agent');
  });
});

describe('buildResolveConflictsPrompt', () => {
  it('names the pull request, conflicted files and merge output', () => {
    const prompt = buildResolveConflictsPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      paths: ['src/a.ts', 'src/b.ts'],
      mergeOutput: 'CONFLICT (content): src/a.ts',
    });

    expect(prompt).toContain('Resolve the merge conflicts on pull request #7');
    expect(prompt).toContain('resolve-conflicts skill');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
    expect(prompt).toContain('CONFLICT (content): src/a.ts');
    expect(prompt).toContain('With OAuth.');
  });

  it('tells the Agent not to reimplement the Issue or push', () => {
    const prompt = buildResolveConflictsPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      paths: [],
      mergeOutput: '',
    });

    expect(prompt).toContain('Do not reimplement the Issue');
    expect(prompt).toContain('Do not push');
  });
});
