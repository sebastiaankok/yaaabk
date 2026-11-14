import type { AgentManager } from '@yaaabk/agents';
import type { AuthModule } from '@yaaabk/auth';
import type { CiTracker } from '@yaaabk/ci-tracker';
import type { IssueSyncModule } from '@yaaabk/github';
import type { GrillMeModule } from '@yaaabk/grill-me';
import type { IssuesModule } from '@yaaabk/issues';
import type { PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import type { SettingsModule } from '@yaaabk/settings';
import { SKILL_LEVELS } from '@yaaabk/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes, requireAuth, type AuthRoutesOptions } from './auth-routes';
import { agentRoutes } from './agent-routes';
import { ciRoutes } from './ci-routes';
import { grillRoutes } from './grill-routes';
import { issueRoutes } from './issue-routes';
import { issueSyncRoutes } from './issue-sync-routes';
import { planRoutes } from './plan-routes';
import { projectRoutes } from './project-routes';
import { settingsRoutes } from './settings-routes';

/** Origin the browser app is served from in development. */
export const DEFAULT_WEB_ORIGIN = 'http://localhost:5173';

export interface AppOptions {
  /**
   * The Auth Module. The Bun entrypoint wires the SQLite-backed module; tests
   * inject one built on the in-memory store and fakes.
   */
  auth: AuthModule;
  /**
   * The Projects Module. The Bun entrypoint wires the real K8s, Template and
   * GitHub adapters; tests inject fakes.
   */
  projects: ProjectsModule;
  /** The Plans Module. Tests inject one over an in-memory store. */
  plans: PlansModule;
  /** The Issues Module. Tests inject one over an in-memory store. */
  issues: IssuesModule;
  /** The Issue sync Module. Tests inject one over a fake GitHub. */
  issueSync: IssueSyncModule;
  /** The Grill-Me Module. Tests inject one over a fake spawner. */
  grillMe: GrillMeModule;
  /** The Agent Manager Module. Tests inject one over a mock cluster. */
  agents: AgentManager;
  /** The CI Tracker Module. Tests inject one over fake GitHub ports. */
  ciTracker: CiTracker;
  /** The Settings Module. Tests inject one over an in-memory store. */
  settings: SettingsModule;
  /** Forwarded to {@link authRoutes}. */
  authRoutesOptions?: AuthRoutesOptions;
  /** Origin allowed to call the API with credentials. Defaults to {@link DEFAULT_WEB_ORIGIN}. */
  webOrigin?: string;
}

/** Builds the YAAABK REST API. */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // Must run before the auth routes so it can answer CORS preflights.
  app.use(
    '/api/*',
    cors({
      origin: options.webOrigin ?? DEFAULT_WEB_ORIGIN,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Everything else under /api requires a valid session; the /api/auth routes
  // short-circuit inside the middleware.
  app.use('/api/*', requireAuth(options.auth));

  app.route('/', authRoutes(options.auth, options.authRoutesOptions));
  app.get('/api/skill-levels', (c) => c.json({ skillLevels: SKILL_LEVELS }));
  app.route('/', projectRoutes(options.projects));
  app.route('/', planRoutes(options.projects, options.plans));
  app.route('/', issueRoutes(options.issues, options.projects, options.plans, options.grillMe));
  app.route('/', issueSyncRoutes(options.issueSync, options.projects));
  app.route('/', agentRoutes(options.agents, options.projects));
  app.route('/', grillRoutes(options.grillMe, options.projects, options.plans, options.issues));
  app.route('/', ciRoutes(options.ciTracker));
  app.route('/', settingsRoutes(options.settings));

  return app;
}
