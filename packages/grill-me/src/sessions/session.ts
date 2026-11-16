import { randomUUID } from 'node:crypto';
import { isSkillLevel, type SkillLevel } from '@yaaabk/shared';
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
}

/** Everything start needs from the Project and Plan modules. */
export interface StartGrillSessionInput {
  projectId: string;
  projectName: string;
  idea: string;
  skillLevel: SkillLevel;
  /** The selected model; defaults to the configured environment model. */
  model?: string | null;
  /** The Project's active Plan, when it has one, used as session context. */
  activePlan?: string | null;
  repoFullName?: string | null;
}

export type GrillSessionErrorKind = 'invalid-input' | 'not-found' | 'start-failed' | 'unknown';

export interface GrillSessionError {
  kind: GrillSessionErrorKind;
  operation: string;
  message: string;
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
  /** Stops the runtime, discards the session and marks it cancelled. */
  cancel(projectId: string, sessionId: string): Promise<GrillSessionResult<GrillSessionView>>;
  /** Records terminal activity so idle reaping can see it. */
  touch(sessionId: string): Promise<GrillSessionResult<void>>;
  /** The ttyd endpoint the backend terminal proxy should connect to. */
  terminal(sessionId: string): Promise<GrillSessionResult<SessionTerminalEndpoint>>;
}

export interface GrillSessionsModuleOptions {
  runtime: SessionRuntime;
  /** Model used when no per-session choice is supplied. */
  defaultModel?: string;
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
    };
  }

  function fail(
    operation: string,
    kind: GrillSessionErrorKind,
    message: string,
  ): GrillSessionResult<never> {
    return { ok: false, error: { operation, kind, message } };
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
    if (runtime === null) return undefined;
    const stopped = await options.runtime.stop(runtime);
    if (!stopped.ok) {
      logger.error('grill session runtime stop failed', {
        sessionId: session.id,
        kind: stopped.error.kind,
      });
      return {
        kind: 'unknown',
        operation: 'stop',
        message: stopped.error.message,
      };
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

      const model = resolveSessionModel(input.model ?? undefined, options.defaultModel);
      const sessionId = newId();
      const startedAt = clock().toISOString();
      const prompt = buildGrillSessionPrompt({
        projectId: input.projectId,
        projectName: input.projectName,
        idea: input.idea,
        skillLevel: input.skillLevel,
        model,
        activePlan: input.activePlan ?? null,
        repoFullName: input.repoFullName ?? null,
      });

      const started = await options.runtime.start({
        sessionId,
        projectId: input.projectId,
        projectName: input.projectName,
        idea: input.idea,
        skillLevel: input.skillLevel,
        prompt,
        model,
      });
      if (!started.ok) {
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
