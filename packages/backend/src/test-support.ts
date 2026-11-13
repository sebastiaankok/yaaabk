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
  createFakeSpawner,
  createGrillMeModule,
  type FakeSpawner,
  type GrillMeModule,
} from '@yaaabk/grill-me';
import { createMockK8sClient } from '@yaaabk/k8s';
import { createInMemoryPlanStore, createPlansModule, type PlansModule } from '@yaaabk/plans';
import {
  createFakeRepositoryProvider,
  createInMemoryProjectStore,
  createProjectsModule,
  silentLogger as projectsLogger,
  type ProjectsModule,
} from '@yaaabk/projects';
import {
  createFakeGitBackend,
  createTemplateModule,
  silentLogger as templateLogger,
} from '@yaaabk/template';
import { createApp, type AppOptions } from './app';

/** A password that satisfies the real policy. */
export const TEST_PASSWORD = 'vX7$qmPz2!Lw9Rt';

/** The only code the fake TOTP accepts. */
export const TEST_CODE = '123456';

/** A fixed instant so session lifetimes are deterministic. */
export const TEST_NOW = Date.UTC(2026, 0, 1, 12);

export interface TestContext {
  app: ReturnType<typeof createApp>;
  auth: AuthModule;
  projects: ProjectsModule;
  plans: PlansModule;
  grillMe: GrillMeModule;
  spawner: FakeSpawner;
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

/** Builds an app whose modules run on fakes and in-memory stores. */
export function createTestContext(
  authRoutesOptions: AppOptions['authRoutesOptions'] = { attemptsPerMinute: 100 },
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

  const projects = createProjectsModule({
    store: createInMemoryProjectStore(),
    k8s: createMockK8sClient(),
    templates: createTemplateModule({
      git: createFakeGitBackend(),
      dryRun: true,
      logger: templateLogger,
    }),
    repositories: createFakeRepositoryProvider(),
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

  const spawner = createFakeSpawner();
  const grillMe = createGrillMeModule({
    spawner,
    skillPath: '/skills/grill-me/SKILL.md',
    logger: silent,
  });

  return {
    app: createApp({ auth, projects, plans, grillMe, authRoutesOptions }),
    auth,
    projects,
    plans,
    grillMe,
    spawner,
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
