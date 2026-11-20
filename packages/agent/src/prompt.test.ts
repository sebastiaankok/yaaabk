import { describe, expect, it } from 'vitest';
import type { AgentConfig } from './config';
import type { AgentIssue } from './ports';
import {
  buildImplementPrompt,
  buildResolveConflictsPrompt,
  buildReviewPrompt,
  REVIEW_VERDICT_PATH,
} from './prompt';

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

  it('names the checkout and says the harness is not the repository', () => {
    const prompt = buildImplementPrompt(ISSUE, CONFIG);

    expect(prompt).toContain('/work/repo');
    expect(prompt).toContain('/app is the harness');
  });

  it('points the Agent at the project check script, not a pre-commit hook', () => {
    const prompt = buildImplementPrompt(ISSUE, CONFIG);

    expect(prompt).toContain('bun run check');
    expect(prompt).not.toContain('pre-commit');
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

  it('names the checkout and says the harness is not the repository', () => {
    const prompt = buildResolveConflictsPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      paths: [],
      mergeOutput: '',
    });

    expect(prompt).toContain('/work/repo');
    expect(prompt).toContain('/app is the harness');
  });

  it('points the Agent at the project check script, not a pre-commit hook', () => {
    const prompt = buildResolveConflictsPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      paths: [],
      mergeOutput: '',
    });

    expect(prompt).toContain('bun run check');
    expect(prompt).not.toContain('pre-commit');
  });
});

describe('buildReviewPrompt', () => {
  it('names the checkout, the verdict path and says the harness is not the repository', () => {
    const prompt = buildReviewPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    });

    expect(prompt).toContain('Review GitHub pull request #7');
    expect(prompt).toContain('/work/repo');
    expect(prompt).toContain('/app is the harness');
    expect(prompt).toContain(REVIEW_VERDICT_PATH);
    expect(REVIEW_VERDICT_PATH).toBe('/work/repo/.yaaabk/review.json');
  });

  it('trusts CI and runs the project checks at most once', () => {
    const prompt = buildReviewPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    });

    expect(prompt).toContain('CI has already run lint, typecheck, tests and build');
    expect(prompt).toContain('Run `bun run check` at most once');
  });

  it('forbids browser, Playwright, Chromium and screenshot work', () => {
    const prompt = buildReviewPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    });

    expect(prompt).toContain('Do not start a browser');
    expect(prompt).toContain('Playwright');
    expect(prompt).toContain('Chromium');
    expect(prompt).toContain('screenshots');
  });

  it('sets a tool-call budget and asks for a verdict once it is exhausted', () => {
    const prompt = buildReviewPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    });

    expect(prompt).toContain('Aim for 20–30 tool calls');
    expect(prompt).toContain('write the verdict with the evidence you have gathered');
  });

  it('forbids build output and compiled CSS work unless the Issue requires it', () => {
    const prompt = buildReviewPrompt(ISSUE, {
      pullNumber: 7,
      branch: 'agent/issue-42',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    });

    expect(prompt).toContain(
      'Do not run `bun run build` unless the diff changes build configuration',
    );
    expect(prompt).toContain(
      'Do not inspect compiled CSS unless the Issue is specifically about build output',
    );
    expect(prompt).toContain(
      'Only run extra commands when a specific concern in the diff requires it',
    );
  });
});
