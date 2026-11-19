/// <reference types="bun" />
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createAgentManager, createSqliteAgentStore, type AgentTokenScope } from '@yaaabk/agents';
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
  createOpenRouterCreditsReader,
  createOpenRouterModelCatalogue,
  createOpenRouterVerifier,
  loadCostControlConfig,
} from '@yaaabk/cost-control';
import {
  createGrillSessionsModule,
  createKubernetesSessionRuntime,
  createLocalSessionRuntime,
  createSqliteGrillSessionStore,
  DEFAULT_GRILL_MODEL,
} from '@yaaabk/grill-me';
import {
  createGitHubCredentialVerifier,
  createGitHubIssuesClient,
  createGitHubPullsClient,
  createInstallationTokenProvider,
  type InstallationTokenProviderOptions,
  createIssueSyncModule,
  type GitHubIssues,
  type GitHubPulls,
  type InstallationTokenPermissions,
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
import { createBunWebSocket } from 'hono/bun';
import { createApp } from './app';
import {
  createGitHubTokenResolver,
  GITHUB_OWNER_UNSET_MESSAGE,
  type GitHubTokenRequest,
  type ResolvedGitHubToken,
} from './github-token';
import {
  createOpenRouterAgentKeys,
  createOpenRouterSessionKeys,
  type SessionKeyIssuerOptions,
} from './session-keys';
import { resolveSessionRuntimeMode } from './session-runtime';

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
  openRouterCredits: createOpenRouterCreditsReader(),
  githubVerifier: createGitHubCredentialVerifier(),
});

/**
 * The credentials present at startup. Budget configuration snapshots this once;
 * the GitHub clients below instead resolve the token per call, so a credential
 * entered in Settings takes effect without a restart.
 */
const bootstrapCredentials = await settings.credentials();

/**
 * Mints GitHub App installation tokens for the currently configured App,
 * cached so the token is reused until it nears expiry.
 *
 * Keyed on the App and installation: saving new credentials must not keep
 * handing out tokens minted for the previous installation.
 */
let installationTokens: InstallationTokenProvider | undefined;
let installationTokenKey: string | undefined;

function mintInstallationToken({
  appId,
  privateKey,
  installationId,
  permissions,
}: InstallationTokenProviderOptions & {
  permissions?: InstallationTokenPermissions;
}): Promise<string> {
  const key = `${appId}:${installationId}`;
  if (installationTokens === undefined || installationTokenKey !== key) {
    installationTokens = createInstallationTokenProvider({
      appId,
      privateKey,
      installationId,
    });
    installationTokenKey = key;
  }
  return installationTokens.token(permissions);
}

/**
 * The GitHub token resolution the ports below share: an App installation token
 * when an App is configured, otherwise the stored PAT or the environment.
 * `resolveGithubToken` names the gap when there is none, so a create reports
 * what to fix instead of one generic "GitHub is not configured".
 */
const resolveTokenFor = createGitHubTokenResolver({ mintInstallationToken });

/** The token a GitHub call should use, or the reason there is none. */
function resolveGithubToken(
  settingsModule: SettingsModule,
  request?: GitHubTokenRequest,
): Promise<ResolvedGitHubToken> {
  return settingsModule.credentials().then((stored) =>
    resolveTokenFor(
      {
        githubAppId: stored.githubAppId,
        githubPrivateKey: stored.githubPrivateKey,
        githubInstallationId: stored.githubInstallationId,
        githubPat: stored.githubPat,
      },
      request,
    ),
  );
}

function unconfigured(
  operation: string,
  message: string,
): { ok: false; error: { kind: 'unauthorized'; operation: string; message: string } } {
  return { ok: false, error: { kind: 'unauthorized', operation, message } };
}

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
      const resolved = await resolveGithubToken(settingsModule);
      if (!resolved.ok) {
        return unconfigured('create', resolved.message);
      }
      if (owner === undefined || owner === '') {
        return unconfigured('create', GITHUB_OWNER_UNSET_MESSAGE);
      }
      return createGitHubRepositoryProvider({
        token: resolved.token,
        owner,
        ownerType,
      }).create(input);
    },
    delete: async (fullName) => {
      const resolved = await resolveGithubToken(settingsModule);
      if (!resolved.ok) {
        return unconfigured('delete', resolved.message);
      }
      return createGitHubRepositoryProvider({
        token: resolved.token,
        owner: owner ?? '',
        ownerType,
      }).delete(fullName);
    },
    addCollaborator: async (fullName, username) => {
      const resolved = await resolveGithubToken(settingsModule);
      if (!resolved.ok) {
        return unconfigured('addCollaborator', resolved.message);
      }
      return createGitHubRepositoryProvider({
        token: resolved.token,
        owner: owner ?? '',
        ownerType,
      }).addCollaborator(fullName, username);
    },
    transfer: async (fullName, target) => {
      const resolved = await resolveGithubToken(settingsModule);
      if (!resolved.ok) {
        return unconfigured('transfer', resolved.message);
      }
      return createGitHubRepositoryProvider({
        token: resolved.token,
        owner: owner ?? '',
        ownerType,
      }).transfer(fullName, target);
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
    const resolved = await resolveGithubToken(settingsModule);
    return resolved.ok
      ? { ok: true as const, client: createGitHubIssuesClient({ token: resolved.token }) }
      : resolved;
  };
  const fail = (operation: string, resolved: Extract<ResolvedGitHubToken, { ok: false }>) =>
    Promise.resolve(unconfigured(operation, resolved.message));
  return {
    ensureLabels: async (...args) => {
      const built = await build();
      return built.ok ? built.client.ensureLabels(...args) : fail('ensureLabels', built);
    },
    createIssue: async (...args) => {
      const built = await build();
      return built.ok ? built.client.createIssue(...args) : fail('createIssue', built);
    },
    updateIssue: async (...args) => {
      const built = await build();
      return built.ok ? built.client.updateIssue(...args) : fail('updateIssue', built);
    },
    getIssue: async (...args) => {
      const built = await build();
      return built.ok ? built.client.getIssue(...args) : fail('getIssue', built);
    },
    listIssues: async (...args) => {
      const built = await build();
      return built.ok ? built.client.listIssues(...args) : fail('listIssues', built);
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
    const resolved = await resolveGithubToken(settingsModule);
    return resolved.ok
      ? { ok: true as const, client: createGitHubPullsClient({ token: resolved.token }) }
      : resolved;
  };
  const fail = (operation: string, resolved: Extract<ResolvedGitHubToken, { ok: false }>) =>
    Promise.resolve(unconfigured(operation, resolved.message));
  return {
    listPullRequests: async (...args) => {
      const built = await build();
      return built.ok ? built.client.listPullRequests(...args) : fail('listPullRequests', built);
    },
    checkState: async (...args) => {
      const built = await build();
      return built.ok ? built.client.checkState(...args) : fail('checkState', built);
    },
    mergeability: async (...args) => {
      const built = await build();
      return built.ok ? built.client.mergeability(...args) : fail('mergeability', built);
    },
    mergePullRequest: async (...args) => {
      const built = await build();
      return built.ok ? built.client.mergePullRequest(...args) : fail('mergePullRequest', built);
    },
    updatePullRequestBranch: async (...args) => {
      const built = await build();
      return built.ok
        ? built.client.updatePullRequestBranch(...args)
        : fail('updatePullRequestBranch', built);
    },
    createReview: async (...args) => {
      const built = await build();
      return built.ok ? built.client.createReview(...args) : fail('createReview', built);
    },
    listReviews: async (...args) => {
      const built = await build();
      return built.ok ? built.client.listReviews(...args) : fail('listReviews', built);
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
 * The GitHub token the scaffold push clones and pushes with, resolved per
 * create. Resolved per call so a credential entered in Settings takes effect
 * without a restart; prefers a short-lived App installation token, which dies
 * within the hour even if a run's Secret leaks.
 */
const resolveGithubTokenForScaffold = async (): Promise<string | undefined> => {
  try {
    const resolved = await resolveGithubToken(settings);
    return resolved.ok ? resolved.token : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The permission each kind of agent Job needs. Implement-issue runs push code,
 * open pull requests and manage Issues; a review run only reads code and the
 * Issue it judges, and posts a review, so a leaked review token cannot push or
 * merge.
 */
const AGENT_TOKEN_PERMISSIONS: Record<AgentTokenScope, InstallationTokenPermissions> = {
  'implement-issue': {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    workflows: 'write',
    metadata: 'read',
  },
  review: {
    contents: 'read',
    pull_requests: 'write',
    // A review starts by fetching the Issue to judge the change against; with
    // only `pull_requests` the fetch fails with 403 and every review dies
    // before cloning.
    issues: 'read',
  },
  'resolve-conflicts': {
    contents: 'write',
    pull_requests: 'write',
    issues: 'read',
  },
  deploy: {
    contents: 'read',
  },
};

/** The GitHub token an agent Job clones and pushes with, scoped to its kind. */
const resolveGithubTokenForAgents = async (scope: AgentTokenScope): Promise<string | undefined> => {
  try {
    const resolved = await resolveGithubToken(settings, {
      permissions: AGENT_TOKEN_PERMISSIONS[scope],
    });
    return resolved.ok ? resolved.token : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The Cost Control configuration is read once. Issue keys and session keys
 * share its default budget, so one deployment setting sizes both.
 */
const costControlConfig = loadCostControlConfig(process.env);

const plans = createPlansModule({ store: createSqlitePlanStore(database) });
const issues = createIssuesModule({
  store: createSqliteIssueStore(database),
  defaultBudgetCents:
    bootstrapCredentials.defaultIssueBudgetCents ?? costControlConfig.defaultBudgetCents,
});

/**
 * Drops a removed Project's local artifacts. Both removals are idempotent, so a
 * partial delete can be retried by deleting the Project again.
 */
const removeProjectArtifacts = async (projectId: string): Promise<void> => {
  const removedPlans = await plans.removeForProject(projectId);
  if (!removedPlans.ok) throw new Error(removedPlans.error.message);
  const removedIssues = await issues.removeForProject(projectId);
  if (!removedIssues.ok) throw new Error(removedIssues.error.message);
};

const projects = createProjectsModule({
  store: projectStore,
  k8s,
  templates: createTemplateModule(),
  repositories: resolveRepositories(settings),
  // Resolved per create so a credential entered in Settings takes effect
  // without a restart, and a short-lived App installation token is minted
  // fresh for the scaffold push rather than snapshotted at startup.
  githubToken: resolveGithubTokenForScaffold,
  onRemoved: removeProjectArtifacts,
});
const issueSync = createIssueSyncModule({ issues, github: resolveGitHubIssues(settings) });

/** Model used when neither the request nor the Project chooses one. */
const defaultModel = process.env['YAAABK_DEFAULT_MODEL'] ?? DEFAULT_GRILL_MODEL;

/**
 * Interactive sessions run as hardened Pods in the Project Namespace when
 * deployed, and as local ttyd + `opencode mini` child processes when
 * developing. Both adapters satisfy the same SessionRuntime port.
 */
const sessionRuntimeMode = resolveSessionRuntimeMode(process.env);
const sessionImage = process.env['YAAABK_SESSION_IMAGE'] ?? process.env['YAAABK_AGENT_IMAGE'];
if (sessionRuntimeMode === 'kubernetes' && (sessionImage === undefined || sessionImage === '')) {
  throw new Error(
    'YAAABK_SESSION_IMAGE (or YAAABK_AGENT_IMAGE) must name the shared OpenCode runtime image',
  );
}
const sessionRuntime =
  sessionRuntimeMode === 'kubernetes'
    ? createKubernetesSessionRuntime({
        k8s,
        image: sessionImage!,
        backendNamespace: process.env['YAAABK_NAMESPACE'] ?? 'yaaabk',
        logger: {
          info: (message, fields) => console.info(message, fields ?? ''),
        },
      })
    : createLocalSessionRuntime({
        ...(process.env['YAAABK_TTYD_BIN'] === undefined
          ? {}
          : { ttydCommand: process.env['YAAABK_TTYD_BIN'] }),
        ...(process.env['YAAABK_OPENCODE_BIN'] === undefined
          ? {}
          : { opencodeCommand: process.env['YAAABK_OPENCODE_BIN'] }),
        ...(process.env['YAAABK_SESSION_CWD'] === undefined
          ? {}
          : { cwd: process.env['YAAABK_SESSION_CWD'] }),
        logger: {
          info: (message, fields) => console.info(message, fields ?? ''),
        },
      });
/**
 * The live OpenRouter catalogue. Routes offer it to the UI, and the key issuer
 * prices the selected model with it so a paid run is refused before it starts
 * when its budget or the account balance cannot cover one full reply.
 */
const modelCatalogue = createOpenRouterModelCatalogue();
const openrouterKeyOptions: SessionKeyIssuerOptions = {
  credentials: () => settings.credentials(),
  ...(process.env['OPENROUTER_MANAGEMENT_KEY'] === undefined
    ? {}
    : { envManagementKey: process.env['OPENROUTER_MANAGEMENT_KEY'] }),
  budgetCents: costControlConfig.defaultBudgetCents,
  catalogue: modelCatalogue,
  logger: {
    info: (message, fields) => console.info(message, fields ?? ''),
    error: (message, fields) => console.error(message, fields ?? ''),
  },
};
const sessionKeys = createOpenRouterSessionKeys(openrouterKeyOptions);
const agentKeys = createOpenRouterAgentKeys(openrouterKeyOptions);

/**
 * The short-lived, contents:read token a session's clone init container uses.
 * A Kubernetes session cannot start without one: an empty workspace would make
 * the grilling generic rather than grounded in the Project's code.
 */
const resolveGithubTokenForSessions = async (): Promise<string> => {
  const resolved = await resolveGithubToken(settings, { permissions: { contents: 'read' } });
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.token;
};

/** Reads an optional positive millisecond setting, ignoring an invalid value. */
function positiveMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const sessionIdleTimeoutMs = positiveMs('YAAABK_SESSION_IDLE_TIMEOUT_MS');
const sessionMaxMs = positiveMs('YAAABK_SESSION_MAX_MS');

const grillSessions = createGrillSessionsModule({
  runtime: sessionRuntime,
  plans,
  issues,
  keys: sessionKeys,
  defaultModel,
  store: createSqliteGrillSessionStore(database),
  ...(sessionRuntimeMode === 'kubernetes'
    ? { cloneToken: async () => resolveGithubTokenForSessions() }
    : {}),
  ...(process.env['YAAABK_SESSION_API_URL'] === undefined
    ? {}
    : { apiUrl: process.env['YAAABK_SESSION_API_URL'] }),
  ...(sessionIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: sessionIdleTimeoutMs }),
  ...(sessionMaxMs === undefined ? {} : { maxSessionMs: sessionMaxMs }),
  logger: {
    info: (message, fields) => console.info(message, fields ?? ''),
    error: (message, fields) => console.error(message, fields ?? ''),
  },
});

/**
 * Re-adopts the sessions a previous backend process left running, fails the
 * ones whose runtime is gone, and removes leftover Pods, keys and report
 * tokens. It runs before the server accepts traffic so no request sees a
 * half-reconciled session.
 */
const reconciled = await grillSessions.reconcile();
if (!reconciled.ok) {
  console.error('grill session reconciliation failed', reconciled.error);
}

/**
 * The Cost Control Module, built from the Settings credential store with the
 * environment as fallback. Without either, an empty management key makes every
 * OpenRouter call fail with a clear `unauthorized` error. Its consumers (the
 * Agent Manager's budget lifecycle) arrive with a later issue.
 */
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
  githubIssues: resolveGitHubIssues(settings),
  githubToken: resolveGithubTokenForAgents,
  mintOpenrouterKey: async (issue, attemptNumber, model) => {
    const minted = await agentKeys.mint(issue.id, issue.budgetCents, attemptNumber, model);
    return minted.ok
      ? { ok: true, key: minted.value.key, hash: minted.value.hash }
      : { ok: false, message: minted.message };
  },
  // Fallback model for both surfaces: Agent Jobs prefer the Issue's model, then
  // the Project's, before this environment default; Grill-Me Sessions use the
  // per-session choice with this as their fallback.
  model: defaultModel,
  ...(process.env.YAAABK_AGENT_IMAGE !== undefined
    ? { image: process.env.YAAABK_AGENT_IMAGE }
    : {}),
  ...(process.env.YAAABK_AGENT_STORAGE_CLASS !== undefined &&
  process.env.YAAABK_AGENT_STORAGE_CLASS.trim() !== ''
    ? { storageClassName: process.env.YAAABK_AGENT_STORAGE_CLASS.trim() }
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

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = createApp({
  auth,
  projects,
  plans,
  issues,
  issueSync,
  grillSessions,
  upgradeWebSocket,
  agents,
  ciTracker,
  settings,
  models: modelCatalogue,
  defaultModel,
  webOrigin: process.env.YAAABK_WEB_ORIGIN,
  authRoutesOptions: { secureCookies: process.env.NODE_ENV === 'production' },
});

/**
 * Reaps sessions that have been idle for 30 minutes or alive for four hours.
 * The interval is configurable so tests and constrained deployments can slow
 * it down; a value of 0 disables the sweep.
 */
const sessionSweepMs = Number(process.env['YAAABK_SESSION_SWEEP_MS'] ?? 60_000);
if (Number.isFinite(sessionSweepMs) && sessionSweepMs > 0) {
  setInterval(() => {
    void grillSessions.sweep().then((result) => {
      if (!result.ok) console.error('grill session sweep failed', result.error);
    });
  }, sessionSweepMs);
}

/**
 * One Agent Manager pass: record finished Jobs and schedule retries first, so
 * their slots are free, then start every `ready` Issue whose dependencies are
 * closed. Overlapping ticks are skipped because a mint or a cluster call can
 * outlast the poll interval. The interval is configurable so tests and
 * constrained clusters can slow it down.
 */
let agentTickRunning = false;
async function runAgentTick(): Promise<void> {
  if (agentTickRunning) return;
  agentTickRunning = true;
  try {
    const reconciled = await agents.reconcile();
    if (!reconciled.ok) {
      console.error('agents reconcile failed', reconciled.error);
    }
    const dispatched = await agents.autoDispatch();
    if (!dispatched.ok) {
      console.error('agents autoDispatch failed', dispatched.error);
    } else if (dispatched.value.scheduled > 0) {
      console.info(`agents autoDispatch scheduled ${dispatched.value.scheduled} run(s)`);
    }
  } finally {
    agentTickRunning = false;
  }
}

const agentPollMs = Number(process.env.YAAABK_AGENT_POLL_MS ?? 15000);
if (Number.isFinite(agentPollMs) && agentPollMs > 0) {
  void runAgentTick();
  setInterval(() => {
    void runAgentTick();
  }, agentPollMs);
}

/**
 * Starts the CI Tracker's polling loop: it watches the pull requests YAAABK's
 * Agents open, merging the passing ones and spawning fix attempts on the
 * failing ones. The loop can be disabled or retimed at runtime through
 * `PATCH /api/admin/ci/config`.
 */
ciTracker.start();

/** Kept as a handle so shutdown can stop accepting requests before exiting. */
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
  websocket,
});

/**
 * Bun leaves SIGTERM at the signal's default action, and the kernel ignores
 * default-action signals in PID 1, which is what the container runs. Without a
 * handler Kubernetes waits out terminationGracePeriodSeconds before SIGKILLing
 * the container. The deployment uses the Recreate strategy (one SQLite writer on
 * a ReadWriteOnce volume), so that wait sits between scaling the old ReplicaSet
 * down and the new one up: every rollout costs an extra 30 seconds.
 *
 * In-flight requests get a short drain, then whatever is left is abandoned.
 * Startup reconciliation re-adopts sessions and Agent Jobs, so this process can
 * exit without flushing anything.
 *
 * The drain waits for `pendingRequests`, not for `server.stop()` to resolve:
 * that promise only settles once every connection is gone, and idle keep-alives
 * (the kubelet's probes, a browser tab) are only closed by the peer, so awaiting
 * it burns the whole grace period on every stop.
 */
const shutdownDrainMs = positiveMs('YAAABK_SHUTDOWN_DRAIN_MS') ?? 5_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`received ${signal}; draining ${server.pendingRequests} in-flight request(s)`);
  // Stop listening so no new request is accepted into the drain.
  void server.stop();
  const deadline = performance.now() + shutdownDrainMs;
  while (server.pendingRequests > 0 && performance.now() < deadline) {
    await Bun.sleep(25);
  }
  if (server.pendingRequests > 0) {
    console.info(
      `dropping ${server.pendingRequests} request(s) still running at the drain deadline`,
    );
  }
  // Force-close idle keep-alives and terminals; nothing useful is left to wait
  // for and `process.exit` would drop the sockets anyway.
  void server.stop(true);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
