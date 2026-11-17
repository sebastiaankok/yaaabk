import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Issue, IssuesModule } from '@yaaabk/issues';
import type { Plan, PlansModule } from '@yaaabk/plans';
import {
  isSkillLevel,
  normaliseGeneratedIssues,
  type GeneratedIssueReport,
  type SkillLevel,
} from '@yaaabk/shared';
import type { SessionKeyIssuer } from './keys';
import { buildGrillSessionPrompt, resolveSessionModel } from './prompt';
import {
  type SessionRuntime,
  type SessionRuntimeRef,
  type SessionTerminalEndpoint,
} from './runtime-types';

/** Where a Grill-Me Session is in its lifecycle. */
export type GrillSessionStatus = 'starting' | 'active' | 'finished' | 'cancelled' | 'failed';

/** Why a session stopped running. */
export type GrillSessionEndReason = 'finished' | 'cancelled' | 'replaced' | 'failed' | 'timeout';

/** What the agent has reported so far, but not yet published. */
export interface GrillSessionDraftSummary {
  /** Whether a PRD draft has been reported. */
  hasPrd: boolean;
  /** How many Issues the latest report holds. */
  issueCount: number;
}

/** The safe, browser-facing shape of a session. Credentials never appear here. */
export interface GrillSessionView {
  id: string;
  projectId: string;
  status: GrillSessionStatus;
  skillLevel: SkillLevel;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: GrillSessionEndReason | null;
  /** A human-readable failure reason when the session failed. */
  error: string | null;
  /** Path the browser opens as a WebSocket for the terminal. */
  terminalPath: string;
  /** What the agent has reported, so the Plan page can warn before Finish. */
  draft: GrillSessionDraftSummary;
}

/** What the reporting MCP server may report in one call. */
export interface GrillSessionReport {
  /** The PRD markdown to store as the draft. Validated before storage. */
  prd?: unknown;
  /** The Issue list to store as the draft. Validated before storage. */
  issues?: unknown;
}

/** The published result of finishing a session. */
export interface GrillSessionFinish {
  session: GrillSessionView;
  plan: Plan;
  issues: Issue[];
}

/** A missing draft that blocks Finish, unless it is forced. */
export type GrillSessionMissingDraft = 'prd' | 'issues';

/** Everything start needs from the Project and Plan modules. */
export interface StartGrillSessionInput {
  projectId: string;
  projectName: string;
  idea: string;
  skillLevel: SkillLevel;
  /** The selected model; defaults to the Project's last-used or environment model. */
  model?: string | null;
  /** The model the Project last used, if any. */
  lastModel?: string | null;
  /** The Project's active Plan, when it has one, used as session context. */
  activePlan?: string | null;
  repoFullName?: string | null;
  /** The Project's Kubernetes Namespace, for the Kubernetes runtime adapter. */
  namespace?: string | null;
}

export type GrillSessionErrorKind =
  | 'invalid-input'
  | 'not-found'
  | 'unauthorized'
  | 'start-failed'
  | 'incomplete'
  | 'publish-failed'
  | 'unknown';

export interface GrillSessionError {
  kind: GrillSessionErrorKind;
  operation: string;
  message: string;
  /** Which drafts are missing, when Finish refuses an incomplete session. */
  missing?: GrillSessionMissingDraft[];
}

export type GrillSessionResult<T> =
  { ok: true; value: T } | { ok: false; error: GrillSessionError };

export interface GrillSessionsModule {
  /** Starts a session, replacing any active session for the same Project. */
  start(input: StartGrillSessionInput): Promise<GrillSessionResult<GrillSessionView>>;
  /** The live session for a Project, or `null` when none is running. */
  getActive(projectId: string): Promise<GrillSessionResult<GrillSessionView | null>>;
  /** One session, including ended sessions, for status rendering. */
  get(projectId: string, sessionId: string): Promise<GrillSessionResult<GrillSessionView>>;
  /**
   * Stores what the session's agent reported as drafts. Authenticated by the
   * per-session bearer token, not the Developer's cookie.
   */
  report(
    sessionId: string,
    token: string,
    report: GrillSessionReport,
  ): Promise<GrillSessionResult<GrillSessionView>>;
  /** The session's status, authenticated by the per-session bearer token. */
  status(sessionId: string, token: string): Promise<GrillSessionResult<GrillSessionView>>;
  /**
   * Publishes the drafts as one Plan version and that Plan's Issues. Without a
   * PRD and at least one Issue it refuses unless `force` is set.
   */
  finish(
    projectId: string,
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<GrillSessionResult<GrillSessionFinish>>;
  /** Stops the runtime, discards the session and marks it cancelled. */
  cancel(projectId: string, sessionId: string): Promise<GrillSessionResult<GrillSessionView>>;
  /** Records terminal activity so idle reaping can see it. */
  touch(sessionId: string): Promise<GrillSessionResult<void>>;
  /** The ttyd endpoint the backend terminal proxy should connect to. */
  terminal(sessionId: string): Promise<GrillSessionResult<SessionTerminalEndpoint>>;
}

export interface GrillSessionsModuleOptions {
  runtime: SessionRuntime;
  /** Where a finished session publishes its Plan and Issues. */
  plans: PlansModule;
  issues: IssuesModule;
  /** Model used when no per-session choice or Project model is supplied. */
  defaultModel?: string;
  /**
   * Mints the budget-limited OpenRouter key each session runs with. When
   * omitted, sessions start without a key (local development and unit tests).
   */
  keys?: SessionKeyIssuer;
  /** Backend base URL the session's reporting MCP server posts to. */
  apiUrl?: string;
  /** Mints the per-session report token. Defaults to 32 random bytes. */
  tokens?: () => string;
  /**
   * Mints the short-lived, contents:read GitHub token a session clones its
   * repository with. Omitted in local development, where the checkout already
   * exists.
   */
  cloneToken?: (input: { projectId: string; repoFullName: string }) => Promise<string | undefined>;
  clock?: () => Date;
  ids?: () => string;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

interface SessionRecord {
  id: string;
  projectId: string;
  projectName: string;
  status: GrillSessionStatus;
  skillLevel: SkillLevel;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: GrillSessionEndReason | null;
  error: string | null;
  runtime: SessionRuntimeRef | null;
  /** SHA-256 of the report token; the plaintext only goes to the runtime. */
  reportTokenHash: string;
  /** OpenRouter key hash for revocation; the plaintext only goes to the runtime. */
  openRouterKeyHash: string | null;
  draft: { prd: string | null; issues: GeneratedIssueReport[] | null };
  /** The Plan this session published, kept so a retried Finish is idempotent. */
  publishedPlan: Plan | null;
  /** The Issues published with that Plan. */
  publishedIssues: Issue[];
  /** A Finish that is in flight, so a double click publishes once. */
  finishInFlight: Promise<GrillSessionResult<GrillSessionFinish>> | null;
}

/** Hashes a report token for storage and comparison. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares a presented token to the stored hash in constant time. */
function tokenMatches(storedHash: string, token: string): boolean {
  const presented = hashToken(token);
  const expected = Buffer.from(storedHash, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function invalidReason(input: StartGrillSessionInput): string | undefined {
  if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
    return 'A project id is required';
  }
  if (typeof input.projectName !== 'string' || input.projectName.trim() === '') {
    return 'A project name is required';
  }
  if (typeof input.idea !== 'string' || input.idea.trim() === '') {
    return 'An idea is required';
  }
  if (!isSkillLevel(input.skillLevel)) {
    return `"${String(input.skillLevel)}" is not a valid skill level`;
  }
  return undefined;
}

/**
 * Owns the browser-facing Lifecycle of Grill-Me Sessions: one per Project,
 * start/get/cancel, activity tracking and the runtime reference. It never
 * exposes runtime credentials to callers.
 */
export function createGrillSessionsModule(
  options: GrillSessionsModuleOptions,
): GrillSessionsModule {
  const clock = options.clock ?? (() => new Date());
  const newId = options.ids ?? randomUUID;
  const logger = options.logger ?? { info: () => {}, error: () => {} };
  const tokens = options.tokens ?? (() => randomBytes(32).toString('hex'));
  const apiUrl =
    options.apiUrl ??
    process.env['YAAABK_SESSION_API_URL'] ??
    process.env['YAAABK_API_URL'] ??
    `http://127.0.0.1:${process.env['PORT'] ?? '3000'}`;
  const sessions = new Map<string, SessionRecord>();

  function isLive(session: SessionRecord): boolean {
    return session.status === 'starting' || session.status === 'active';
  }

  function activeFor(projectId: string): SessionRecord | undefined {
    for (const session of sessions.values()) {
      if (session.projectId === projectId && isLive(session)) return session;
    }
    return undefined;
  }

  function view(session: SessionRecord): GrillSessionView {
    return {
      id: session.id,
      projectId: session.projectId,
      status: session.status,
      skillLevel: session.skillLevel,
      model: session.model,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      endedAt: session.endedAt,
      endReason: session.endReason,
      error: session.error,
      terminalPath: `/api/projects/${encodeURIComponent(session.projectId)}/grill/${encodeURIComponent(session.id)}/terminal`,
      draft: {
        hasPrd: session.draft.prd !== null,
        issueCount: session.draft.issues?.length ?? 0,
      },
    };
  }

  function fail(
    operation: string,
    kind: GrillSessionErrorKind,
    message: string,
    missing?: GrillSessionMissingDraft[],
  ): GrillSessionResult<never> {
    return {
      ok: false,
      error: { operation, kind, message, ...(missing === undefined ? {} : { missing }) },
    };
  }

  /** Resolves a session by its report token, or reports the matching failure. */
  function authenticate(
    operation: string,
    sessionId: string,
    token: string,
  ): SessionRecord | GrillSessionResult<never> {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      return fail(operation, 'not-found', `No grill session "${sessionId}"`);
    }
    if (!isLive(session)) {
      return fail(operation, 'unauthorized', `Grill session "${sessionId}" has ended`);
    }
    if (!tokenMatches(session.reportTokenHash, token)) {
      return fail(operation, 'unauthorized', 'The session token is not valid');
    }
    return session;
  }

  function discardDrafts(session: SessionRecord): void {
    session.draft = { prd: null, issues: null };
  }

  function find(projectId: string, sessionId: string): SessionRecord | undefined {
    const session = sessions.get(sessionId);
    return session !== undefined && session.projectId === projectId ? session : undefined;
  }

  async function stop(
    session: SessionRecord,
    reason: GrillSessionEndReason,
  ): Promise<GrillSessionError | undefined> {
    if (!isLive(session)) return undefined;
    const runtime = session.runtime;
    session.status =
      reason === 'failed' ? 'failed' : reason === 'finished' ? 'finished' : 'cancelled';
    session.endReason = reason;
    session.endedAt = clock().toISOString();
    if (reason !== 'finished') discardDrafts(session);

    const stopFailure = runtime === null ? undefined : await options.runtime.stop(runtime);
    await revokeKey(session);

    if (stopFailure !== undefined && !stopFailure.ok) {
      logger.error('grill session runtime stop failed', {
        sessionId: session.id,
        kind: stopFailure.error.kind,
      });
      return {
        kind: 'unknown',
        operation: 'stop',
        message: stopFailure.error.message,
      };
    }
    return undefined;
  }

  /** Revokes the session's OpenRouter key; a failure is logged, not fatal. */
  async function revokeKey(session: SessionRecord): Promise<void> {
    const hash = session.openRouterKeyHash;
    session.openRouterKeyHash = null;
    if (hash === null || options.keys === undefined) return;
    try {
      await options.keys.revoke(hash);
    } catch (error) {
      logger.error('grill session key revoke failed', {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async start(input) {
      const invalid = invalidReason(input);
      if (invalid !== undefined) return fail('start', 'invalid-input', invalid);

      const previous = activeFor(input.projectId);
      if (previous !== undefined) {
        await stop(previous, 'replaced');
        logger.info('grill session replaced', {
          projectId: input.projectId,
          sessionId: previous.id,
        });
      }

      const model = resolveSessionModel(
        input.model ?? input.lastModel ?? undefined,
        options.defaultModel,
      );
      const sessionId = newId();
      const startedAt = clock().toISOString();
      const reportToken = tokens();

      let openRouterKey: string | undefined;
      let openRouterKeyHash: string | null = null;
      if (options.keys !== undefined) {
        try {
          const issued = await options.keys.issue(sessionId);
          if (!issued.ok) {
            logger.error('grill session key mint failed', { sessionId });
            return fail('start', 'start-failed', issued.message);
          }
          openRouterKey = issued.value.key;
          openRouterKeyHash = issued.value.hash;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('grill session key mint failed', { sessionId, message });
          return fail('start', 'start-failed', `Could not create the session key: ${message}`);
        }
      }

      const prompt = buildGrillSessionPrompt({
        projectId: input.projectId,
        projectName: input.projectName,
        idea: input.idea,
        skillLevel: input.skillLevel,
        model,
        activePlan: input.activePlan ?? null,
        repoFullName: input.repoFullName ?? null,
      });

      let gitToken: string | undefined;
      if (
        options.cloneToken !== undefined &&
        input.repoFullName !== undefined &&
        input.repoFullName !== null
      ) {
        try {
          gitToken = await options.cloneToken({
            projectId: input.projectId,
            repoFullName: input.repoFullName,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('grill session clone token mint failed', {
            sessionId,
            projectId: input.projectId,
            message,
          });
          if (openRouterKeyHash !== null && options.keys !== undefined) {
            try {
              await options.keys.revoke(openRouterKeyHash);
            } catch {
              // Best effort: the start is already failing.
            }
          }
          return fail('start', 'start-failed', `Could not create the repository token: ${message}`);
        }
      }

      const started = await options.runtime.start({
        sessionId,
        projectId: input.projectId,
        projectName: input.projectName,
        ...(input.namespace === undefined || input.namespace === null
          ? {}
          : { namespace: input.namespace }),
        ...(input.repoFullName === undefined || input.repoFullName === null
          ? {}
          : { repoFullName: input.repoFullName }),
        ...(gitToken === undefined ? {} : { gitToken }),
        idea: input.idea,
        skillLevel: input.skillLevel,
        prompt,
        model,
        ...(openRouterKey === undefined ? {} : { openRouterKey }),
        reportToken,
        apiUrl,
      });
      if (!started.ok) {
        if (openRouterKeyHash !== null && options.keys !== undefined) {
          try {
            await options.keys.revoke(openRouterKeyHash);
          } catch (error) {
            logger.error('grill session key revoke failed', {
              sessionId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        logger.error('grill session start failed', {
          projectId: input.projectId,
          kind: started.error.kind,
        });
        return fail(
          'start',
          started.error.kind === 'invalid-input' ? 'invalid-input' : 'start-failed',
          started.error.message,
        );
      }

      const session: SessionRecord = {
        id: sessionId,
        projectId: input.projectId,
        projectName: input.projectName,
        status: 'active',
        skillLevel: input.skillLevel,
        model,
        startedAt,
        lastActivityAt: startedAt,
        endedAt: null,
        endReason: null,
        error: null,
        runtime: started.value,
        reportTokenHash: hashToken(reportToken),
        openRouterKeyHash,
        draft: { prd: null, issues: null },
        publishedPlan: null,
        publishedIssues: [],
        finishInFlight: null,
      };
      sessions.set(sessionId, session);
      logger.info('grill session started', { sessionId, projectId: input.projectId, model });
      return { ok: true, value: view(session) };
    },

    async getActive(projectId) {
      const active = activeFor(projectId);
      return { ok: true, value: active === undefined ? null : view(active) };
    },

    async get(projectId, sessionId) {
      const session = find(projectId, sessionId);
      return session === undefined
        ? fail('get', 'not-found', `No grill session "${sessionId}" for project "${projectId}"`)
        : { ok: true, value: view(session) };
    },

    async report(sessionId, token, report) {
      const session = authenticate('report', sessionId, token);
      if ('ok' in session) return session;

      const hasPrd = report.prd !== undefined;
      const hasIssues = report.issues !== undefined;
      if (!hasPrd && !hasIssues) {
        return fail('report', 'invalid-input', 'A PRD or an issue list is required');
      }

      let prd: string | undefined;
      if (hasPrd) {
        if (typeof report.prd !== 'string' || report.prd.trim() === '') {
          return fail('report', 'invalid-input', 'The PRD must be markdown text');
        }
        prd = report.prd.trim();
      }

      let issues: GeneratedIssueReport[] | undefined;
      if (hasIssues) {
        const normalised = normaliseGeneratedIssues(report.issues);
        if (!normalised.ok) {
          return fail('report', 'invalid-input', normalised.message);
        }
        if (normalised.value.length === 0) {
          return fail('report', 'invalid-input', 'An issue list must contain at least one issue');
        }
        issues = normalised.value;
      }

      if (issues !== undefined && (prd ?? session.draft.prd) === null) {
        return fail('report', 'invalid-input', 'Report a PRD before its issues');
      }

      if (prd !== undefined) session.draft.prd = prd;
      if (issues !== undefined) session.draft.issues = issues;
      session.lastActivityAt = clock().toISOString();
      return { ok: true, value: view(session) };
    },

    async status(sessionId, token) {
      const session = authenticate('status', sessionId, token);
      return 'ok' in session ? session : { ok: true, value: view(session) };
    },

    async finish(projectId, sessionId, finishOptions = {}) {
      const session = find(projectId, sessionId);
      if (session === undefined) {
        return fail(
          'finish',
          'not-found',
          `No grill session "${sessionId}" for project "${projectId}"`,
        );
      }
      if (session.status === 'finished' && session.publishedPlan !== null) {
        return {
          ok: true,
          value: {
            session: view(session),
            plan: session.publishedPlan,
            issues: session.publishedIssues,
          },
        };
      }
      if (!isLive(session)) {
        return fail('finish', 'not-found', `Grill session "${sessionId}" has ended`);
      }

      const missing: GrillSessionMissingDraft[] = [];
      if (session.draft.prd === null) missing.push('prd');
      if (session.draft.issues === null || session.draft.issues.length === 0)
        missing.push('issues');
      if (missing.length > 0 && finishOptions.force !== true) {
        const names = missing.map((item) => (item === 'prd' ? 'a PRD' : 'an issue list'));
        return fail(
          'finish',
          'incomplete',
          `Cannot finish: ${names.join(' and ')} missing`,
          missing,
        );
      }
      // A Plan cannot exist without a PRD, so forcing does not bypass this one.
      if (session.draft.prd === null) {
        return fail('finish', 'incomplete', 'Cannot finish: a PRD missing', ['prd']);
      }
      const prd = session.draft.prd;

      // A double click must not create two Plan versions. Concurrent Finish
      // calls share the first publication.
      if (session.finishInFlight !== null) return session.finishInFlight;
      const publishing = (async (): Promise<GrillSessionResult<GrillSessionFinish>> => {
        let plan = session.publishedPlan;
        if (plan === null) {
          const created = await options.plans.create({
            projectId,
            contentMarkdown: prd,
            skillLevel: session.skillLevel,
            source: 'grill-me',
          });
          if (!created.ok) {
            logger.error('grill session plan publish failed', {
              sessionId,
              kind: created.error.kind,
            });
            return fail('finish', 'publish-failed', created.error.message);
          }
          plan = created.value;
          // Remember the Plan immediately so a retry after a failed issue publish
          // reuses it instead of creating a second version.
          session.publishedPlan = plan;
        }

        let publishedIssues = session.publishedIssues;
        if (session.draft.issues !== null && session.draft.issues.length > 0) {
          const replaced = await options.issues.replaceForPlan(
            projectId,
            plan.id,
            session.draft.issues,
          );
          if (!replaced.ok) {
            logger.error('grill session issues publish failed', {
              sessionId,
              kind: replaced.error.kind,
            });
            return fail('finish', 'publish-failed', replaced.error.message);
          }
          publishedIssues = replaced.value;
          session.publishedIssues = publishedIssues;
        }

        const stopped = await stop(session, 'finished');
        if (stopped !== undefined) {
          logger.error('grill session runtime stop failed after publishing', {
            sessionId,
            kind: stopped.kind,
          });
        }
        discardDrafts(session);
        logger.info('grill session finished', { sessionId, planId: plan.id });
        return { ok: true, value: { session: view(session), plan, issues: publishedIssues } };
      })();
      session.finishInFlight = publishing;
      try {
        return await publishing;
      } finally {
        session.finishInFlight = null;
      }
    },

    async cancel(projectId, sessionId) {
      const session = find(projectId, sessionId);
      if (session === undefined) {
        return fail(
          'cancel',
          'not-found',
          `No grill session "${sessionId}" for project "${projectId}"`,
        );
      }
      if (!isLive(session)) {
        return fail('cancel', 'not-found', `Grill session "${sessionId}" is not running`);
      }
      const stopped = await stop(session, 'cancelled');
      if (stopped !== undefined) return { ok: false, error: stopped };
      return { ok: true, value: view(session) };
    },

    async touch(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return fail('touch', 'not-found', `No grill session "${sessionId}"`);
      }
      if (isLive(session)) session.lastActivityAt = clock().toISOString();
      return { ok: true, value: undefined };
    },

    async terminal(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined || session.runtime === null) {
        return fail('terminal', 'not-found', `No running terminal for session "${sessionId}"`);
      }
      if (!isLive(session)) {
        return fail('terminal', 'not-found', `Grill session "${sessionId}" has ended`);
      }
      return { ok: true, value: session.runtime.terminal };
    },
  };
}
