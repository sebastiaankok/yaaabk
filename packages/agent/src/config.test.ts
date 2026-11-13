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
      issueNumber: 42,
      repoUrl: 'https://github.com/acme/demo',
      githubToken: 'ghs_token',
      openrouterApiKey: 'sk-or-key',
      maxAttempts: 3,
    });
  });

  it('defaults the attempt budget to 3 and allows an override', () => {
    expect(loadAgentConfig({ ...baseEnv, MAX_ATTEMPTS: '5' }).maxAttempts).toBe(5);
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
