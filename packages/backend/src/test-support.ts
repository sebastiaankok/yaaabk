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
  store: AuthStore;
  clock: { ms: number };
  password: string;
  code: string;
}

const silent = { info: () => {}, error: () => {} };

/** Builds an app whose Auth Module runs on fakes and an in-memory store. */
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

  return {
    app: createApp({ auth, authRoutesOptions }),
    auth,
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
