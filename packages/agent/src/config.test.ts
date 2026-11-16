import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from './config';

const baseEnv = {
  ISSUE_NUMBER: '42',
  REPO_URL: 'https://github.com/acme/demo',
  GITHUB_TOKEN: 'ghs_token',
  OPENROUTER_API_KEY: 'sk-or-key',
};

describe('loadAgentConfig', () => {
  it('reads the issue the agent is scoped to', () => {
    expect(loadAgentConfig(baseEnv)).toEqual({
      kind: 'implement-issue',
      issueNumber: 42,
      repoUrl: 'https://github.com/acme/demo',
      githubToken: 'ghs_token',
      openrouterApiKey: 'sk-or-key',
      maxAttempts: 3,
    });
  });

  it('reads the review mode and the pull request it judges', () => {
    const config = loadAgentConfig({
      ...baseEnv,
      AGENT_RUN_KIND: 'review',
      PULL_NUMBER: '7',
      BRANCH: 'agent/issue-42',
    });

    expect(config).toMatchObject({ kind: 'review', pullNumber: 7, branch: 'agent/issue-42' });
  });

  it('rejects an unknown run kind', () => {
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_RUN_KIND: 'invalid' })).toThrow(
      /AGENT_RUN_KIND/,
    );
  });

  it('reads the deploy run configuration', () => {
    const config = loadAgentConfig({
      ISSUE_NUMBER: '42',
      REPO_URL: 'https://github.com/acme/demo',
      GITHUB_TOKEN: 'ghs_token',
      AGENT_RUN_KIND: 'deploy',
      COMMIT_SHA: 'abc123def456',
      DEPLOY_NAMESPACE: 'yaaabk-a1b2c3d4',
      DEPLOYMENT_NAME: 'todo-app',
      DEPLOY_PATH: 'deploy',
      BRANCH: 'main',
    });

    expect(config).toMatchObject({
      kind: 'deploy',
      openrouterApiKey: '',
      commitSha: 'abc123def456',
      namespace: 'yaaabk-a1b2c3d4',
      deploymentName: 'todo-app',
      deployPath: 'deploy',
      branch: 'main',
    });
  });

  it('rejects a deploy run missing commit SHA, namespace, or deployment name', () => {
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_RUN_KIND: 'deploy',
        DEPLOY_NAMESPACE: 'yaaabk-a1b2c3d4',
        DEPLOYMENT_NAME: 'todo-app',
      }),
    ).toThrow(/COMMIT_SHA/);

    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_RUN_KIND: 'deploy',
        COMMIT_SHA: 'abc123',
        DEPLOYMENT_NAME: 'todo-app',
      }),
    ).toThrow(/DEPLOY_NAMESPACE/);

    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_RUN_KIND: 'deploy',
        COMMIT_SHA: 'abc123',
        DEPLOY_NAMESPACE: 'yaaabk-a1b2c3d4',
      }),
    ).toThrow(/DEPLOYMENT_NAME/);
  });

  it('rejects a review run that does not say which pull request to judge', () => {
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_RUN_KIND: 'review',
        BRANCH: 'agent/issue-42',
      }),
    ).toThrow(/PULL_NUMBER/);
  });

  it('rejects a review run without a branch to check out', () => {
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_RUN_KIND: 'review',
        PULL_NUMBER: '7',
      }),
    ).toThrow(/BRANCH/);
  });

  it('rejects a pull number that is not a positive integer', () => {
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_RUN_KIND: 'review',
        BRANCH: 'agent/issue-42',
        PULL_NUMBER: '0',
      }),
    ).toThrow(/PULL_NUMBER/);
  });

  it('defaults the attempt budget to 3 and allows an override', () => {
    expect(loadAgentConfig({ ...baseEnv, MAX_ATTEMPTS: '5' }).maxAttempts).toBe(5);
  });

  it('reads the fix branch when the Job was given one', () => {
    expect(loadAgentConfig({ ...baseEnv, BRANCH: 'agent/issue-42' }).branch).toBe('agent/issue-42');
    expect(loadAgentConfig(baseEnv).branch).toBeUndefined();
  });

  it('reads reviewer feedback when a fix attempt was given it', () => {
    const config = loadAgentConfig({ ...baseEnv, REVIEW_FEEDBACK: 'Please rename the helper.' });

    expect(config.reviewFeedback).toBe('Please rename the helper.');
    expect(loadAgentConfig(baseEnv).reviewFeedback).toBeUndefined();
  });

  it('fails fast when a required variable is missing', () => {
    expect(() => loadAgentConfig({ ...baseEnv, GITHUB_TOKEN: undefined })).toThrow(/GITHUB_TOKEN/);
    expect(() => loadAgentConfig({ ...baseEnv, REPO_URL: '' })).toThrow(/REPO_URL/);
  });

  it('rejects an issue number that is not a positive integer', () => {
    expect(() => loadAgentConfig({ ...baseEnv, ISSUE_NUMBER: 'not-a-number' })).toThrow(
      /ISSUE_NUMBER/,
    );
    expect(() => loadAgentConfig({ ...baseEnv, ISSUE_NUMBER: '0' })).toThrow(/ISSUE_NUMBER/);
  });
});
