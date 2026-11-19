import {
  createAuthModule,
  createFakePasswordHasher,
  createFakeTotp,
  createInMemoryAuthStore,
  createPasswordPolicy,
  createTokenService,
  MIN_SECRET_LENGTH,
  type AuthModule,
  type AuthStore,
} from '@yaaabk/auth';
import {
  createFakeSessionKeys,
  createFakeSessionRuntime,
  createGrillSessionsModule,
  type FakeSessionKeys,
  type FakeSessionRuntime,
  type GrillSessionsModule,
} from '@yaaabk/grill-me';
import {
  createFakeGitHubIssues,
  createFakeGitHubPulls,
  createIssueSyncModule,
  type FakeGitHubIssues,
  type FakeGitHubPulls,
  type IssueSyncModule,
} from '@yaaabk/github';
import { createMockK8sClient, type MockK8sClient } from '@yaaabk/k8s';
import { createInMemoryIssueStore, createIssuesModule, type IssuesModule } from '@yaaabk/issues';
import { createInMemoryPlanStore, createPlansModule, type PlansModule } from '@yaaabk/plans';
import {
  createFakeRepositoryProvider,
  createInMemoryProjectStore,
  createProjectsModule,
  silentLogger as projectsLogger,
  type ProjectStore,
  type ProjectsModule,
  type RepositoryProvider,
} from '@yaaabk/projects';
import {
  createAgentManager,
  createInMemoryAgentStore,
  silentLogger as agentsLogger,
  type AgentManager,
} from '@yaaabk/agents';
import { createCiTracker, silentLogger as ciLogger, type CiTracker } from '@yaaabk/ci-tracker';
import {
  createCostControlModule,
  createFakeOpenRouterApi,
  createInMemoryBudgetStore,
  silentLogger as budgetLogger,
  type CostControlModule,
  type FakeOpenRouterApi,
  type ModelCatalogue,
  type SessionModel,
} from '@yaaabk/cost-control';
import {
  createFakeGitHubVerifier,
  createFakeOpenRouterCreditsReader,
  createFakeOpenRouterVerifier,
  createInMemorySettingsStore,
  createSecretCrypto,
  createSettingsModule,
  type OpenRouterCreditsReader,
  type SettingsModule,
} from '@yaaabk/settings';
import {
  createFakeGitBackend,
  createTemplateModule,
  silentLogger as templateLogger,
} from '@yaaabk/template';
import type { UpgradeWebSocket } from 'hono/ws';
import { createApp, type AppOptions } from './app';
import type { GrillRoutesOptions } from './grill-routes';

/** A password that satisfies the real policy. */
export const TEST_PASSWORD = 'vX7$qmPz2!Lw9Rt';

/** The only code the fake TOTP accepts. */
export const TEST_CODE = '123456';

/** The default model the test app reports. */
export const TEST_DEFAULT_MODEL = 'openrouter/default-model';

/** A scripted model catalogue for route tests. */
export interface FakeModelCatalogue extends ModelCatalogue {
  readonly calls: number;
  set(models: SessionModel[]): void;
  fail(message: string): void;
}

function createFakeModelCatalogue(): FakeModelCatalogue {
  let models: SessionModel[] = [
    {
      id: TEST_DEFAULT_MODEL,
      name: 'Default model',
      contextLength: 200000,
      maxCompletionTokens: 64000,
      promptUsdPerMillion: 3,
      completionUsdPerMillion: 15,
    },
    {
      id: 'openrouter/chosen',
      name: 'Chosen model',
      contextLength: 200000,
      maxCompletionTokens: 64000,
      promptUsdPerMillion: 3,
      completionUsdPerMillion: 15,
    },
  ];
  let failure: string | undefined;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    set(next) {
      models = next;
    },
    fail(message) {
      failure = message;
    },
    async list() {
      calls += 1;
      if (failure !== undefined) {
        return {
          ok: false,
          error: { kind: 'server', operation: 'list', message: failure },
        };
      }
      return { ok: true, value: models };
    },
  };
}

/** A fixed instant so session lifetimes are deterministic. */
export const TEST_NOW = Date.UTC(2026, 0, 1, 12);

export interface TestContext {
  app: ReturnType<typeof createApp>;
  auth: AuthModule;
  projects: ProjectsModule;
  plans: PlansModule;
  issues: IssuesModule;
  issueSync: IssueSyncModule;
  github: FakeGitHubIssues;
  grillSessions: GrillSessionsModule;
  sessionRuntime: FakeSessionRuntime;
  sessionKeys: FakeSessionKeys;
  models: FakeModelCatalogue;
  agents: AgentManager;
  ciTracker: CiTracker;
  issueBudgets: CostControlModule;
  budgetApi: FakeOpenRouterApi;
  pulls: FakeGitHubPulls;
  settings: SettingsModule;
  openRouterCredits: ReturnType<typeof createFakeOpenRouterCreditsReader> & OpenRouterCreditsReader;
  projectStore: ProjectStore;
  k8s: MockK8sClient;
  store: AuthStore;
  clock: { ms: number };
  password: string;
  code: string;
}

const silent = { info: () => {}, error: () => {} };

/** Hands out distinct, namespace-derivable Project ids within a test run. */
let projectSequence = 0;
function nextProjectId(): string {
  projectSequence += 1;
  return `${projectSequence.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

/** Hands out distinct Plan ids within a test run. */
let planSequence = 0;
function nextPlanId(): string {
  planSequence += 1;
  return `plan-${planSequence.toString(16).padStart(8, '0')}`;
}

/** Hands out distinct Issue ids within a test run. */
let issueSequence = 0;
function nextIssueId(): string {
  issueSequence += 1;
  return `issue-${issueSequence.toString(16).padStart(8, '0')}`;
}

export interface TestContextOverrides {
  upgradeWebSocket?: UpgradeWebSocket;
  grillRoutesOptions?: Omit<GrillRoutesOptions, 'upgradeWebSocket'>;
}

/** Builds an app whose modules run on fakes and in-memory stores. */
export function createTestContext(
  authRoutesOptions: AppOptions['authRoutesOptions'] = { attemptsPerMinute: 100 },
  repositories: RepositoryProvider = createFakeRepositoryProvider(),
  overrides: TestContextOverrides = {},
): TestContext {
  const clock = { ms: TEST_NOW };
  const store = createInMemoryAuthStore();
  const tokens = createTokenService({
    secret: 'x'.repeat(MIN_SECRET_LENGTH),
    now: () => new Date(clock.ms),
  });
  const auth = createAuthModule({
    store,
    tokens,
    hasher: createFakePasswordHasher(),
    totp: createFakeTotp({ token: TEST_CODE }),
    policy: createPasswordPolicy(),
    now: () => new Date(clock.ms),
    logger: silent,
  });

  const projectStore = createInMemoryProjectStore();
  const k8s = createMockK8sClient();
  const projects = createProjectsModule({
    store: projectStore,
    k8s,
    templates: createTemplateModule({
      git: createFakeGitBackend(),
      dryRun: true,
      logger: templateLogger,
    }),
    repositories,
    githubToken: 'gh-token',
    ids: nextProjectId,
    clock: () => new Date(clock.ms),
    logger: projectsLogger,
  });

  const plans = createPlansModule({
    store: createInMemoryPlanStore(),
    ids: nextPlanId,
    clock: () => new Date(clock.ms),
    logger: silent,
  });

  const issues = createIssuesModule({
    store: createInMemoryIssueStore(),
    ids: nextIssueId,
    clock: () => new Date(clock.ms),
    logger: silent,
  });

  const github = createFakeGitHubIssues();
  const issueSync = createIssueSyncModule({
    issues,
    github,
    clock: () => new Date(clock.ms),
    sleep: async () => {},
    logger: silent,
  });

  const sessionRuntime = createFakeSessionRuntime();
  const sessionKeys = createFakeSessionKeys();
  const grillSessions = createGrillSessionsModule({
    runtime: sessionRuntime,
    plans,
    issues,
    keys: sessionKeys,
    defaultModel: TEST_DEFAULT_MODEL,
    ids: () => `grill-${Math.random().toString(16).slice(2, 10)}`,
    clock: () => new Date(clock.ms),
    logger: silent,
  });

  const agents = createAgentManager({
    store: createInMemoryAgentStore(),
    issues,
    projects: projectStore,
    k8s,
    githubIssues: github,
    ids: () => `run-${Math.random().toString(16).slice(2, 10)}`,
    clock: () => new Date(clock.ms),
    logger: agentsLogger,
  });

  const pulls = createFakeGitHubPulls();
  const openRouterCredits = createFakeOpenRouterCreditsReader();
  const settings = createSettingsModule({
    store: createInMemorySettingsStore(),
    crypto: createSecretCrypto({ secret: 'x'.repeat(MIN_SECRET_LENGTH) }),
    openRouterVerifier: createFakeOpenRouterVerifier(),
    openRouterCredits,
    githubVerifier: createFakeGitHubVerifier(),
  });
  const models = createFakeModelCatalogue();
  const budgetApi = createFakeOpenRouterApi();
  const issueBudgets = createCostControlModule({
    api: budgetApi,
    store: createInMemoryBudgetStore(),
    now: () => new Date(clock.ms),
    logger: budgetLogger,
  });
  const ciTracker = createCiTracker({
    projects: projectStore,
    issues,
    agents,
    pulls,
    githubIssues: github,
    clock: () => new Date(clock.ms),
    logger: ciLogger,
  });

  return {
    app: createApp({
      auth,
      projects,
      plans,
      issues,
      issueSync,
      grillSessions,
      ...(overrides.upgradeWebSocket === undefined
        ? {}
        : { upgradeWebSocket: overrides.upgradeWebSocket }),
      ...(overrides.grillRoutesOptions === undefined
        ? {}
        : { grillRoutesOptions: overrides.grillRoutesOptions }),
      agents,
      ciTracker,
      settings,
      models,
      issueBudgets,
      defaultModel: TEST_DEFAULT_MODEL,
      authRoutesOptions,
    }),
    auth,
    projects,
    plans,
    issues,
    issueSync,
    github,
    grillSessions,
    sessionRuntime,
    sessionKeys,
    models,
    agents,
    ciTracker,
    issueBudgets,
    budgetApi,
    pulls,
    settings,
    openRouterCredits,
    projectStore,
    k8s,
    store,
    clock,
    password: TEST_PASSWORD,
    code: TEST_CODE,
  };
}

/** Runs first-run setup and returns the signed-in session token. */
export async function signIn(context: TestContext): Promise<string> {
  const begun = await context.auth.beginSetup({
    username: 'alice',
    password: context.password,
  });
  if (!begun.ok) throw new Error('beginSetup failed');
  const verified = await context.auth.verifySetup({
    setupToken: begun.value.setupToken,
    token: context.code,
  });
  if (!verified.ok) throw new Error('verifySetup failed');
  return verified.value.sessionToken;
}

/** Extracts the value of a `Set-Cookie` header for `name`, if present. */
export function cookieValue(response: Response, name: string): string | undefined {
  const header = response.headers.get('set-cookie');
  const match = header?.match(new RegExp(`${name}=([^;]*)`));
  return match?.[1];
}
