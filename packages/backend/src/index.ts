/// <reference types="bun" />
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  createAuthModule,
  createBcryptHasher,
  createPasswordPolicy,
  createSqliteAuthStore,
  createTokenService,
  createTotp,
  MIN_SECRET_LENGTH,
} from '@yaaabk/auth';
import { createGrillMeModule } from '@yaaabk/grill-me';
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
const projects = createProjectsModule({
  store: createSqliteProjectStore(database),
  k8s: createK8sClient({ connection: detectK8sConnection() }),
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
const grillMe = createGrillMeModule();

const app = createApp({
  auth,
  projects,
  plans,
  issues,
  grillMe,
  webOrigin: process.env.YAAABK_WEB_ORIGIN,
  authRoutesOptions: { secureCookies: process.env.NODE_ENV === 'production' },
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
