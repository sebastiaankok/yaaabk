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
import { createInMemoryGrillSessionStore, type GrillSessionStore } from './store';

/** Where a Grill-Me Session is in its lifecycle. */
export type GrillSessionStatus = 'starting' | 'active' | 'finished' | 'cancelled' | 'failed';

/** Why a session stopped running. */
export type GrillSessionEndReason = 'finished' | 'cancelled' | 'replaced' | 'failed' | 'timeout';

/** A session that has gone this long without terminal traffic is reaped. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;

/** A session is stopped this long after it started, active or not. */
export const DEFAULT_SESSION_MAX_MS = 4 * 60 * 60_000;

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
  /** A human-readable failure or timeout reason when the session failed. */
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

/** The sessions a sweep ended. */
export interface GrillSessionSweep {
  ended: string[];
}

/** What a restart reconciliation did to the sessions and their runtimes. */
export interface GrillSessionReconciliation {
  /** Live sessions whose runtime was found and kept. */
  adopted: string[];
  /** Sessions marked failed because their runtime was gone or broken. */
  failed: string[];
  /** Runtimes stopped because no live session owned them. */
  stopped: string[];
}

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
  /** Ends sessions that exceeded the idle timeout or the hard cap. */
  sweep(): Promise<GrillSessionResult<GrillSessionSweep>>;
  /**
   * Reconciles persisted sessions with the runtimes that exist now. Called once
   * on backend start: live runtimes are re-adopted, missing ones fail the
   * session, and runtimes no live session owns are stopped.
   */
  reconcile(): Promise<GrillSessionResult<GrillSessionReconciliation>>;
}

export interface GrillSessionsModuleOptions {
  runtime: SessionRuntime;
  /** Where a finished session publishes its Plan and Issues. */
  plans: PlansModule;
  issues: IssuesModule;
  /** Session persistence. Defaults to an in-memory store. */
  store?: GrillSessionStore;
  /** Model used when no per-session choice or Project model is supplied. */
  defaultModel?: string;
  /** How long a session may be idle before it is reaped. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  /** How long a session may live from start. Defaults to four hours. */
  maxSessionMs?: number;
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
  /**
   * Session id generator. Ids double as OpenCode session ids, so they must
   * start with `ses`; the default satisfies this.
   */
  ids?: () => string;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

/** The persisted shape of a session. */
export interface GrillSessionRecord {
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
  /** SHA-256 of the report token; cleared when the session ends. */
  reportTokenHash: string | null;
  /** OpenRouter key hash for revocation; the plaintext only goes to the runtime. */
  openRouterKeyHash: string | null;
  draft: { prd: string | null; issues: GeneratedIssueReport[] | null };
  /** The Plan this session published, kept so a retried Finish is idempotent. */
  publishedPlan: Plan | null;
  /** The Issues published with that Plan. */
  publishedIssues: Issue[];
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

function minutesOf(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function hoursOf(ms: number): number {
  return Math.max(1, Math.round(ms / 3_600_000));
}

/**
 * Owns the browser-facing lifecycle of Grill-Me Sessions: one per Project,
 * start/get/finish/cancel, activity tracking, idle and hard-cap reaping,
 * restart reconciliation and the runtime reference. It never exposes runtime
 * credentials to callers.
 */
export function createGrillSessionsModule(
  options: GrillSessionsModuleOptions,
): GrillSessionsModule {
  const clock = options.clock ?? (() => new Date());
  // OpenCode validates the session id it resumes or creates and rejects any id
  // that does not start with "ses". Session ids are opaque elsewhere, so mint
  // them in OpenCode's namespace.
  const newId = options.ids ?? (() => `ses_${randomUUID()}`);
  const logger = options.logger ?? { info: () => {}, error: () => {} };
  const tokens = options.tokens ?? (() => randomBytes(32).toString('hex'));
  const store = options.store ?? createInMemoryGrillSessionStore();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const maxSessionMs = options.maxSessionMs ?? DEFAULT_SESSION_MAX_MS;
  const apiUrl =
    options.apiUrl ??
    process.env['YAAABK_SESSION_API_URL'] ??
    process.env['YAAABK_API_URL'] ??
    `http://127.0.0.1:${process.env['PORT'] ?? '3000'}`;

  /** A Finish that is in flight, so a double click publishes once. */
  const finishInFlight = new Map<string, Promise<GrillSessionResult<GrillSessionFinish>>>();

  function isLive(session: GrillSessionRecord): boolean {
    return session.status === 'starting' || session.status === 'active';
  }

  function activeFor(projectId: string): GrillSessionRecord | undefined {
    for (const session of store.list()) {
      if (session.projectId === projectId && isLive(session)) return session;
    }
    return undefined;
  }

  function view(session: GrillSessionRecord): GrillSessionView {
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
  ): GrillSessionRecord | GrillSessionResult<never> {
    const session = store.get(sessionId);
    if (session === undefined) {
      return fail(operation, 'not-found', `No grill session "${sessionId}"`);
    }
    if (!isLive(session)) {
      return fail(operation, 'unauthorized', `Grill session "${sessionId}" has ended`);
    }
    if (session.reportTokenHash === null || !tokenMatches(session.reportTokenHash, token)) {
      return fail(operation, 'unauthorized', 'The session token is not valid');
    }
    return session;
  }

  function discardDrafts(session: GrillSessionRecord): void {
    session.draft = { prd: null, issues: null };
  }

  function find(projectId: string, sessionId: string): GrillSessionRecord | undefined {
    const session = store.get(sessionId);
    return session !== undefined && session.projectId === projectId ? session : undefined;
  }

  async function stop(
    session: GrillSessionRecord,
    reason: GrillSessionEndReason,
    error?: string,
  ): Promise<GrillSessionError | undefined> {
    if (!isLive(session)) return undefined;
    const runtime = session.runtime;
    session.status =
      reason === 'finished'
        ? 'finished'
        : reason === 'cancelled' || reason === 'replaced'
          ? 'cancelled'
          : 'failed';
    session.endReason = reason;
    session.endedAt = clock().toISOString();
    session.error = reason === 'finished' ? null : (error ?? null);
    // Ending the session revokes its report token: the stored hash is the only
    // thing that could authenticate a late report.
    session.reportTokenHash = null;
    if (reason !== 'finished') discardDrafts(session);

    const stopFailure = runtime === null ? undefined : await options.runtime.stop(runtime);
    await revokeKey(session);
    store.save(session);

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
  async function revokeKey(session: GrillSessionRecord): Promise<void> {
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

  /** The reason a live session should be reaped now, if any. */
  function expiryReason(session: GrillSessionRecord, now: Date): string | undefined {
    const startedAt = Date.parse(session.startedAt);
    if (Number.isFinite(startedAt) && now.getTime() - startedAt >= maxSessionMs) {
      return `Session reached its ${hoursOf(maxSessionMs)}-hour limit`;
    }
    const lastActivityAt = Date.parse(session.lastActivityAt);
    if (Number.isFinite(lastActivityAt) && now.getTime() - lastActivityAt >= idleTimeoutMs) {
      return `Session ended after ${minutesOf(idleTimeoutMs)} minutes without terminal activity`;
    }
    return undefined;
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
          const issued = await options.keys.issue(sessionId, model);
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

      const session: GrillSessionRecord = {
        id: sessionId,
        projectId: input.projectId,
        projectName: input.projectName,
        // Persisted before the runtime exists, so a backend that dies mid-start
        // can still fail the session and reap any Pod the start created.
        status: 'starting',
        skillLevel: input.skillLevel,
        model,
        startedAt,
        lastActivityAt: startedAt,
        endedAt: null,
        endReason: null,
        error: null,
        runtime: null,
        reportTokenHash: hashToken(reportToken),
        openRouterKeyHash,
        draft: { prd: null, issues: null },
        publishedPlan: null,
        publishedIssues: [],
      };
      store.save(session);

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
        await stop(session, 'failed', started.error.message);
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

      session.status = 'active';
      session.runtime = started.value;
      store.save(session);
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
      store.save(session);
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
      const inFlight = finishInFlight.get(sessionId);
      if (inFlight !== undefined) return inFlight;
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
          store.save(session);
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
          store.save(session);
        }

        const stopped = await stop(session, 'finished');
        if (stopped !== undefined) {
          logger.error('grill session runtime stop failed after publishing', {
            sessionId,
            kind: stopped.kind,
          });
        }
        // stop() keeps the published Plan; the drafts are no longer needed.
        discardDrafts(session);
        store.save(session);
        logger.info('grill session finished', { sessionId, planId: plan.id });
        return { ok: true, value: { session: view(session), plan, issues: publishedIssues } };
      })();
      finishInFlight.set(sessionId, publishing);
      try {
        return await publishing;
      } finally {
        finishInFlight.delete(sessionId);
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
      const session = store.get(sessionId);
      if (session === undefined) {
        return fail('touch', 'not-found', `No grill session "${sessionId}"`);
      }
      if (isLive(session)) {
        session.lastActivityAt = clock().toISOString();
        store.save(session);
      }
      return { ok: true, value: undefined };
    },

    async terminal(sessionId) {
      const session = store.get(sessionId);
      if (session === undefined || session.runtime === null) {
        return fail('terminal', 'not-found', `No running terminal for session "${sessionId}"`);
      }
      if (!isLive(session)) {
        return fail('terminal', 'not-found', `Grill session "${sessionId}" has ended`);
      }
      return { ok: true, value: session.runtime.terminal };
    },

    async sweep() {
      const now = clock();
      const ended: string[] = [];
      for (const session of store.list()) {
        if (!isLive(session)) continue;
        const reason = expiryReason(session, now);
        if (reason === undefined) continue;
        const failure = await stop(session, 'timeout', reason);
        if (failure !== undefined) {
          logger.error('grill session timeout stop failed', {
            sessionId: session.id,
            message: failure.message,
          });
        }
        ended.push(session.id);
      }
      return { ok: true, value: { ended } };
    },

    async reconcile() {
      const adopted: string[] = [];
      const failed: string[] = [];
      const stopped: string[] = [];

      const listed = await options.runtime.list();
      if (!listed.ok) {
        logger.error('grill session runtime list failed', {
          kind: listed.error.kind,
          message: listed.error.message,
        });
      }
      const refs = listed.ok ? listed.value : [];

      for (const session of store.list()) {
        if (!isLive(session)) {
          // A crash can leave credentials behind; end-state reaping revokes them.
          let changed = false;
          if (session.openRouterKeyHash !== null) {
            await revokeKey(session);
            changed = true;
          }
          if (session.reportTokenHash !== null) {
            session.reportTokenHash = null;
            changed = true;
          }
          if (changed) store.save(session);
          continue;
        }

        if (session.runtime === null) {
          await stop(session, 'failed', 'The session runtime was never created');
          failed.push(session.id);
          continue;
        }

        const inspected = await options.runtime.inspect(session.runtime);
        if (!inspected.ok) {
          await stop(
            session,
            'failed',
            `The session runtime is missing: ${inspected.error.message}`,
          );
          failed.push(session.id);
          continue;
        }

        const inspection = inspected.value;
        if (inspection.state === 'failed') {
          await stop(session, 'failed', inspection.reason ?? 'The session runtime failed');
          failed.push(session.id);
          continue;
        }
        if (inspection.state === 'stopped') {
          await stop(session, 'failed', 'The session runtime stopped before the session ended');
          failed.push(session.id);
          continue;
        }

        // Re-adopt: a live runtime keeps its session, drafts and terminal.
        if (inspection.terminal !== undefined) session.runtime.terminal = inspection.terminal;
        session.status = 'active';
        store.save(session);
        adopted.push(session.id);
      }

      const liveIds = new Set(
        store
          .list()
          .filter(isLive)
          .map((session) => session.id),
      );
      const finished = new Set<string>();
      for (const ref of refs) {
        if (liveIds.has(ref.sessionId) || finished.has(ref.sessionId)) continue;
        const result = await options.runtime.stop(ref);
        finished.add(ref.sessionId);
        if (result.ok) {
          stopped.push(ref.sessionId);
        } else {
          logger.error('grill session orphan runtime stop failed', {
            sessionId: ref.sessionId,
            kind: result.error.kind,
          });
        }
      }

      logger.info('grill session reconciliation complete', {
        adopted: adopted.length,
        failed: failed.length,
        stopped: stopped.length,
      });
      return { ok: true, value: { adopted, failed, stopped } };
    },
  };
}
