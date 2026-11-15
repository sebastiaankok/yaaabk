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
import {
  createCostControlModule,
  createInMemoryBudgetStore,
  createOpenRouterApi,
  createOpenRouterVerifier,
  loadCostControlConfig,
} from '@yaaabk/cost-control';
import { createGrillMeModule } from '@yaaabk/grill-me';
import {
  createGitHubCredentialVerifier,
  createGitHubIssuesClient,
  createGitHubPullsClient,
  createInstallationTokenProvider,
  createIssueSyncModule,
  type GitHubIssues,
  type GitHubPulls,
  type GitHubResult,
  type InstallationTokenProvider,
} from '@yaaabk/github';
import { createIssuesModule, createSqliteIssueStore } from '@yaaabk/issues';
import { createK8sClient, detectK8sConnection, ensureInClusterCaTrusted } from '@yaaabk/k8s';
import { createPlansModule, createSqlitePlanStore } from '@yaaabk/plans';
import {
  createGitHubRepositoryProvider,
  createProjectsModule,
  createSqliteProjectStore,
  type RepositoryProvider,
} from '@yaaabk/projects';
import {
  createSecretCrypto,
  createSettingsModule,
  createSqliteSettingsStore,
  type SettingsModule,
} from '@yaaabk/settings';
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

const authSecret = resolveAuthSecret();

const dataDir = process.env.YAAABK_DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

const database = new Database(join(dataDir, 'yaaabk.db'));

const settings = createSettingsModule({
  store: createSqliteSettingsStore(database),
  crypto: createSecretCrypto({ secret: authSecret }),
  openRouterVerifier: createOpenRouterVerifier(),
  githubVerifier: createGitHubCredentialVerifier(),
});

/**
 * The credentials present at startup. Budget configuration snapshots this once;
 * the GitHub clients below instead resolve the token per call, so a credential
 * entered in Settings takes effect without a restart.
 */
const bootstrapCredentials = await settings.credentials();

/**
 * The GitHub App installation token provider for the currently configured App
 * credentials, cached so its token is reused until it nears expiry.
 */
let installationTokens: InstallationTokenProvider | undefined;

async function appInstallationToken(
  credentials: Awaited<ReturnType<SettingsModule['credentials']>>,
): Promise<string | undefined> {
  const { githubAppId, githubPrivateKey, githubInstallationId } = credentials;
  if (
    githubAppId === undefined ||
    githubAppId === '' ||
    githubPrivateKey === undefined ||
    githubPrivateKey === '' ||
    githubInstallationId === undefined ||
    githubInstallationId === ''
  ) {
    installationTokens = undefined;
    return undefined;
  }
  installationTokens ??= createInstallationTokenProvider({
    appId: githubAppId,
    privateKey: githubPrivateKey,
    installationId: githubInstallationId,
  });
  return installationTokens.token();
}

/**
 * The token a GitHub call should use.
 *
 * A configured GitHub App wins: its installation token is short-lived
 * (roughly an hour) and scoped to the permissions the installation was
 * granted, so nothing long-lived with broad repository access is ever used.
 * The stored PAT and the environment variable remain fallbacks.
 */
async function resolveGithubToken(settingsModule: SettingsModule): Promise<string | undefined> {
  const stored = await settingsModule.credentials();
  const fromApp = await appInstallationToken(stored);
  if (fromApp !== undefined) {
    return fromApp;
  }
  if (stored.githubPat !== undefined && stored.githubPat !== '') {
    return stored.githubPat;
  }
  const fromEnv = process.env.YAAABK_GITHUB_TOKEN;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
}

function unconfigured(
  operation: string,
  message: string,
): { ok: false; error: { kind: 'unauthorized'; operation: string; message: string } } {
  return {
    ok: false,
    error: {
      kind: 'unauthorized',
      operation,
      message,
    },
  };
}

const GITHUB_UNCONFIGURED_MESSAGE =
  'GitHub is not configured; add a GitHub PAT in Settings or set YAAABK_GITHUB_TOKEN (and YAAABK_GITHUB_OWNER to create projects)';

/**
 * Resolves the Repository port from the Settings credential store, falling back
 * to the environment. Without credentials every create fails with a clear typed
 * error rather than breaking startup.
 */
function resolveRepositories(settingsModule: SettingsModule): RepositoryProvider {
  const owner = process.env.YAAABK_GITHUB_OWNER;
  const ownerType = resolveGitHubOwnerType();
  return {
    create: async (input) => {
      const token = await resolveGithubToken(settingsModule);
      if (token === undefined || owner === undefined || owner === '') {
        return unconfigured('create', GITHUB_UNCONFIGURED_MESSAGE);
      }
      return createGitHubRepositoryProvider({ token, owner, ownerType }).create(input);
    },
    delete: async (fullName) => {
      const token = await resolveGithubToken(settingsModule);
      if (token === undefined) {
        return unconfigured('delete', GITHUB_UNCONFIGURED_MESSAGE);
      }
      return createGitHubRepositoryProvider({ token, owner: owner ?? '', ownerType }).delete(
        fullName,
      );
    },
    addCollaborator: async (fullName, username) => {
      const token = await resolveGithubToken(settingsModule);
      if (token === undefined) {
        return unconfigured('addCollaborator', GITHUB_UNCONFIGURED_MESSAGE);
      }
      return createGitHubRepositoryProvider({
        token,
        owner: owner ?? '',
        ownerType,
      }).addCollaborator(fullName, username);
    },
    transfer: async (fullName, target) => {
      const token = await resolveGithubToken(settingsModule);
      if (token === undefined) {
        return unconfigured('transfer', GITHUB_UNCONFIGURED_MESSAGE);
      }
      return createGitHubRepositoryProvider({ token, owner: owner ?? '', ownerType }).transfer(
        fullName,
        target,
      );
    },
  };
}

/** How the Projects Module creates repositories. */
function resolveGitHubOwnerType(): 'org' | 'user' {
  return process.env.YAAABK_GITHUB_OWNER_TYPE === 'user' ? 'user' : 'org';
}

/**
 * Resolves the GitHub Issues port from the Settings credential store, falling
 * back to the environment; without credentials every sync fails with a clear
 * typed error rather than breaking startup.
 */
function resolveGitHubIssues(settingsModule: SettingsModule): GitHubIssues {
  const build = async () => {
    const token = await resolveGithubToken(settingsModule);
    return token === undefined ? undefined : createGitHubIssuesClient({ token });
  };
  const fail = (operation: string): Promise<GitHubResult<never>> =>
    Promise.resolve(unconfigured(operation, GITHUB_UNCONFIGURED_MESSAGE));
  return {
    ensureLabels: async (...args) => {
      const client = await build();
      return client === undefined ? fail('ensureLabels') : client.ensureLabels(...args);
    },
    createIssue: async (...args) => {
      const client = await build();
      return client === undefined ? fail('createIssue') : client.createIssue(...args);
    },
    updateIssue: async (...args) => {
      const client = await build();
      return client === undefined ? fail('updateIssue') : client.updateIssue(...args);
    },
    getIssue: async (...args) => {
      const client = await build();
      return client === undefined ? fail('getIssue') : client.getIssue(...args);
    },
    listIssues: async (...args) => {
      const client = await build();
      return client === undefined ? fail('listIssues') : client.listIssues(...args);
    },
  };
}

/**
 * Resolves the GitHub Pulls port the CI Tracker drives from the Settings
 * credential store, falling back to the environment; without credentials every
 * poll fails with a clear typed error rather than breaking startup.
 */
function resolveGitHubPulls(settingsModule: SettingsModule): GitHubPulls {
  const build = async () => {
    const token = await resolveGithubToken(settingsModule);
    return token === undefined ? undefined : createGitHubPullsClient({ token });
  };
  const fail = (operation: string): Promise<GitHubResult<never>> =>
    Promise.resolve(unconfigured(operation, GITHUB_UNCONFIGURED_MESSAGE));
  return {
    listPullRequests: async (...args) => {
      const client = await build();
      return client === undefined ? fail('listPullRequests') : client.listPullRequests(...args);
    },
    checkState: async (...args) => {
      const client = await build();
      return client === undefined ? fail('checkState') : client.checkState(...args);
    },
    mergePullRequest: async (...args) => {
      const client = await build();
      return client === undefined ? fail('mergePullRequest') : client.mergePullRequest(...args);
    },
  };
}

const auth = createAuthModule({
  store: createSqliteAuthStore(database),
  tokens: createTokenService({ secret: authSecret }),
  hasher: createBcryptHasher(),
  totp: createTotp({ issuer: 'YAAABK' }),
  policy: createPasswordPolicy(),
});

const projectStore = createSqliteProjectStore(database);
// Must run before the first in-cluster TLS connection: Bun's undici ignores the
// CA @kubernetes/client-node loads, so every API call fails with "self signed
// certificate in certificate chain" without this.
ensureInClusterCaTrusted();
const k8s = createK8sClient({ connection: detectK8sConnection() });

/**
 * The GitHub token agent Jobs clone and push with, resolved per dispatch.
 *
 * Resolved per call so a credential entered in Settings takes effect without a
 * restart; prefers a short-lived GitHub App installation token, which dies
 * within the hour even if a run's Secret leaks.
 */
const resolveGithubTokenForAgents = async (): Promise<string | undefined> => {
  try {
    return await resolveGithubToken(settings);
  } catch {
    return undefined;
  }
};

const projects = createProjectsModule({
  store: projectStore,
  k8s,
  templates: createTemplateModule(),
  repositories: resolveRepositories(settings),
  // Resolved per create so a credential entered in Settings takes effect
  // without a restart, and a short-lived App installation token is minted
  // fresh for the scaffold push rather than snapshotted at startup.
  githubToken: resolveGithubTokenForAgents,
});

const plans = createPlansModule({ store: createSqlitePlanStore(database) });
const issues = createIssuesModule({
  store: createSqliteIssueStore(database),
  ...(bootstrapCredentials.defaultIssueBudgetCents !== undefined
    ? { defaultBudgetCents: bootstrapCredentials.defaultIssueBudgetCents }
    : process.env.YAAABK_DEFAULT_ISSUE_BUDGET_CENTS !== undefined
      ? { defaultBudgetCents: Number(process.env.YAAABK_DEFAULT_ISSUE_BUDGET_CENTS) }
      : {}),
});
const issueSync = createIssueSyncModule({ issues, github: resolveGitHubIssues(settings) });
const grillMe = createGrillMeModule();

/**
 * The Cost Control Module, built from the Settings credential store with the
 * environment as fallback. Without either, an empty management key makes every
 * OpenRouter call fail with a clear `unauthorized` error. Its consumers (the
 * Agent Manager's budget lifecycle) arrive with a later issue.
 */
const costControlConfig = loadCostControlConfig(process.env);
createCostControlModule({
  api: createOpenRouterApi({
    managementKey:
      bootstrapCredentials.openrouterManagementKey ?? costControlConfig.managementKey ?? '',
  }),
  store: createInMemoryBudgetStore(),
  defaultBudgetCents:
    bootstrapCredentials.defaultIssueBudgetCents ?? costControlConfig.defaultBudgetCents,
});

const agents = createAgentManager({
  store: createSqliteAgentStore(database),
  issues,
  projects: projectStore,
  k8s,
  githubToken: await resolveGithubTokenForAgents(),
  ...(process.env.YAAABK_AGENT_IMAGE !== undefined
    ? { image: process.env.YAAABK_AGENT_IMAGE }
    : {}),
  ...(process.env.YAAABK_API_URL !== undefined ? { apiUrl: process.env.YAAABK_API_URL } : {}),
});

const ciTracker = createCiTracker({
  projects: projectStore,
  issues,
  agents,
  pulls: resolveGitHubPulls(settings),
  githubIssues: resolveGitHubIssues(settings),
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
  settings,
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
