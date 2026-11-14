/// <reference types="bun" />
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createAgentManager, createSqliteAgentStore } from '@yaaabk/agents';
import {
  createAuthModule,
  createBcryptHasher,
  createPasswordPolicy,
  createSqliteAuthStore,
  createTokenService,
  createTotp,
  MIN_SECRET_LENGTH,
} from '@yaaabk/auth';
import { createCiTracker } from '@yaaabk/ci-tracker';
import { createGrillMeModule } from '@yaaabk/grill-me';
import {
  createGitHubIssuesClient,
  createGitHubPullsClient,
  createIssueSyncModule,
  type GitHubIssues,
  type GitHubPulls,
  type GitHubResult,
} from '@yaaabk/github';
import { createIssuesModule, createSqliteIssueStore } from '@yaaabk/issues';
import { createK8sClient, detectK8sConnection } from '@yaaabk/k8s';
import { createPlansModule, createSqlitePlanStore } from '@yaaabk/plans';
import {
  createGitHubRepositoryProvider,
  createProjectsModule,
  createSqliteProjectStore,
  type RepositoryProvider,
} from '@yaaabk/projects';
import { createTemplateModule } from '@yaaabk/template';
import { createApp } from './app';

/** Resolves the HS256 secret, generating an ephemeral one for local dev. */
function resolveAuthSecret(): string {
  const configured = process.env.YAAABK_AUTH_SECRET;
  if (configured !== undefined && configured.length >= MIN_SECRET_LENGTH) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`YAAABK_AUTH_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`);
  }
  console.warn(
    'YAAABK_AUTH_SECRET is not set; using an ephemeral secret. Sessions will not survive a restart.',
  );
  return Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64');
}

/** How the Projects Module creates repositories. */
function resolveGitHubOwnerType(): 'org' | 'user' {
  return process.env.YAAABK_GITHUB_OWNER_TYPE === 'user' ? 'user' : 'org';
}

/**
 * Resolves the Repository port. Until the Settings credential store exists,
 * credentials come from the environment; without them every create fails with a
 * clear typed error rather than breaking startup.
 */
function resolveRepositories(): RepositoryProvider {
  const token = process.env.YAAABK_GITHUB_TOKEN;
  const owner = process.env.YAAABK_GITHUB_OWNER;
  if (token !== undefined && token !== '' && owner !== undefined && owner !== '') {
    return createGitHubRepositoryProvider({ token, owner, ownerType: resolveGitHubOwnerType() });
  }
  const message =
    'GitHub is not configured; set YAAABK_GITHUB_TOKEN and YAAABK_GITHUB_OWNER to create projects';
  return {
    create: async () => ({
      ok: false,
      error: { kind: 'unauthorized', operation: 'create', message },
    }),
    delete: async () => ({
      ok: false,
      error: { kind: 'unauthorized', operation: 'delete', message },
    }),
  };
}

/**
 * Resolves the GitHub Issues port. Until the Settings credential store exists,
 * credentials come from the environment; without them every sync fails with a
 * clear typed error rather than breaking startup.
 */
function resolveGitHubIssues(): GitHubIssues {
  const token = process.env.YAAABK_GITHUB_TOKEN;
  if (token !== undefined && token !== '') {
    return createGitHubIssuesClient({ token });
  }
  const message = 'GitHub is not configured; set YAAABK_GITHUB_TOKEN to sync issues';
  const fail = async (): Promise<GitHubResult<never>> => ({
    ok: false,
    error: { kind: 'unauthorized', operation: 'github', message },
  });
  return {
    ensureLabels: fail,
    createIssue: fail,
    updateIssue: fail,
    getIssue: fail,
    listIssues: fail,
  };
}

/**
 * Resolves the GitHub Pulls port the CI Tracker drives. Until the Settings
 * credential store exists, credentials come from the environment; without them
 * every poll fails with a clear typed error rather than breaking startup.
 */
function resolveGitHubPulls(): GitHubPulls {
  const token = process.env.YAAABK_GITHUB_TOKEN;
  if (token !== undefined && token !== '') {
    return createGitHubPullsClient({ token });
  }
  const message = 'GitHub is not configured; set YAAABK_GITHUB_TOKEN to watch pull requests';
  const fail = async (): Promise<GitHubResult<never>> => ({
    ok: false,
    error: { kind: 'unauthorized', operation: 'github', message },
  });
  return {
    listPullRequests: fail,
    checkState: fail,
    mergePullRequest: fail,
  };
}

const dataDir = process.env.YAAABK_DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

const database = new Database(join(dataDir, 'yaaabk.db'));

const auth = createAuthModule({
  store: createSqliteAuthStore(database),
  tokens: createTokenService({ secret: resolveAuthSecret() }),
  hasher: createBcryptHasher(),
  totp: createTotp({ issuer: 'YAAABK' }),
  policy: createPasswordPolicy(),
});

const githubToken = process.env.YAAABK_GITHUB_TOKEN;
const projectStore = createSqliteProjectStore(database);
const k8s = createK8sClient({ connection: detectK8sConnection() });
const projects = createProjectsModule({
  store: projectStore,
  k8s,
  templates: createTemplateModule(),
  repositories: resolveRepositories(),
  ...(githubToken !== undefined && githubToken !== '' ? { githubToken } : {}),
});

const plans = createPlansModule({ store: createSqlitePlanStore(database) });
const issues = createIssuesModule({
  store: createSqliteIssueStore(database),
  ...(process.env.YAAABK_DEFAULT_ISSUE_BUDGET_CENTS !== undefined
    ? { defaultBudgetCents: Number(process.env.YAAABK_DEFAULT_ISSUE_BUDGET_CENTS) }
    : {}),
});
const issueSync = createIssueSyncModule({ issues, github: resolveGitHubIssues() });
const grillMe = createGrillMeModule();

const agents = createAgentManager({
  store: createSqliteAgentStore(database),
  issues,
  projects: projectStore,
  k8s,
  ...(process.env.YAAABK_AGENT_IMAGE !== undefined
    ? { image: process.env.YAAABK_AGENT_IMAGE }
    : {}),
  ...(process.env.YAAABK_API_URL !== undefined ? { apiUrl: process.env.YAAABK_API_URL } : {}),
});

const ciTracker = createCiTracker({
  projects: projectStore,
  issues,
  agents,
  pulls: resolveGitHubPulls(),
  githubIssues: resolveGitHubIssues(),
  ...(process.env.YAAABK_CI_POLL_MS !== undefined &&
  Number.isFinite(Number(process.env.YAAABK_CI_POLL_MS)) &&
  Number(process.env.YAAABK_CI_POLL_MS) > 0
    ? { intervalMs: Number(process.env.YAAABK_CI_POLL_MS) }
    : {}),
});

const app = createApp({
  auth,
  projects,
  plans,
  issues,
  issueSync,
  grillMe,
  agents,
  ciTracker,
  webOrigin: process.env.YAAABK_WEB_ORIGIN,
  authRoutesOptions: { secureCookies: process.env.NODE_ENV === 'production' },
});

/**
 * Drives the Agent Manager: dispatches queued attempts, records finished Jobs
 * and schedules retries. The interval is configurable so tests and constrained
 * clusters can slow it down.
 */
const agentPollMs = Number(process.env.YAAABK_AGENT_POLL_MS ?? 15000);
if (Number.isFinite(agentPollMs) && agentPollMs > 0) {
  setInterval(() => {
    void agents.reconcile().then((result) => {
      if (!result.ok) {
        console.error('agents reconcile failed', result.error);
      }
    });
  }, agentPollMs);
}

/**
 * Starts the CI Tracker's polling loop: it watches the pull requests YAAABK's
 * Agents open, merging the passing ones and spawning fix attempts on the
 * failing ones. The loop can be disabled or retimed at runtime through
 * `PATCH /api/admin/ci/config`.
 */
ciTracker.start();

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
