import {
  createSseStream,
  silentLogger,
  type GrillMeError,
  type GrillMeLogger,
  type GrillMeModule,
} from '@yaaabk/grill-me';
import type { PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import type { SkillLevel } from '@yaaabk/shared';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asString, body, fail, projectOrResponse } from './http';

/**
 * A grill-me failure maps to the HTTP status the caller should act on: a
 * malformed request is a 400, a missing session is a 404, a process failure is
 * a 502, and a timeout is a 504.
 */
const STATUS_BY_KIND: Record<GrillMeError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'unknown-session': 404,
  'spawn-failed': 502,
  'write-failed': 502,
  timeout: 504,
  'invalid-issues': 422,
  'process-failed': 502,
  unknown: 500,
};

export interface GrillRoutesOptions {
  logger?: GrillMeLogger;
}

/** A session the backend is currently routing, and the Project it belongs to. */
interface Session {
  projectId: string;
  sessionId: string;
  skillLevel: SkillLevel;
}

/** Builds the `/api/projects/:id/grill` routes. */
export function grillRoutes(
  grillMe: GrillMeModule,
  projects: ProjectsModule,
  plans: PlansModule,
  options: GrillRoutesOptions = {},
): Hono {
  const app = new Hono();
  const logger = options.logger ?? silentLogger;
  const sessionsByProject = new Map<string, Session>();
  const sessionsById = new Map<string, Session>();

  // A plan is persisted when the skill emits its <PLAN> marker. The event is
  // synchronous, so the save is fired and the SSE stream is not blocked on it.
  grillMe.on('plan_ready', ({ sessionId, plan }) => {
    const session = sessionsById.get(sessionId);
    if (session === undefined) {
      return;
    }
    void plans
      .create({
        projectId: session.projectId,
        contentMarkdown: plan,
        skillLevel: session.skillLevel,
        source: 'grill-me',
      })
      .then((result) => {
        if (!result.ok) {
          logger.error('grill-me plan save failed', {
            sessionId,
            kind: result.error.kind,
          });
        }
      });
  });

  grillMe.on('ended', ({ sessionId }) => {
    const session = sessionsById.get(sessionId);
    if (session !== undefined) {
      sessionsById.delete(sessionId);
      sessionsByProject.delete(session.projectId);
    }
  });

  function requireSession(projectId: string, sessionId: string): Session | undefined {
    const session = sessionsById.get(sessionId);
    return session !== undefined && session.projectId === projectId ? session : undefined;
  }

  function unknownSession(c: Parameters<typeof fail>[0], sessionId: string) {
    return c.json(
      { error: 'unknown-session', message: `No active grill-me session "${sessionId}"` },
      404,
    );
  }

  app.post('/api/projects/:id/grill', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const idea = asString(input.idea ?? input.message);

    // A Project has one grill-me session at a time. Starting a new one cancels
    // the previous conversation so the two cannot interleave.
    const previous = sessionsByProject.get(project.id);
    if (previous !== undefined) {
      await grillMe.cancelSession(previous.sessionId);
      sessionsById.delete(previous.sessionId);
      sessionsByProject.delete(project.id);
    }

    const result = await grillMe.startSession(project.id, idea, project.skillLevel);
    if (!result.ok) {
      return fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
    }

    const session: Session = {
      projectId: project.id,
      sessionId: result.value,
      skillLevel: project.skillLevel,
    };
    sessionsById.set(session.sessionId, session);
    sessionsByProject.set(project.id, session);

    return c.json({ sessionId: session.sessionId }, 201);
  });

  app.get('/api/projects/:id/grill', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const sessionId = c.req.query('sessionId');
    if (sessionId === undefined || sessionId === '') {
      return c.json({ error: 'invalid-input', message: 'A sessionId is required' }, 400);
    }
    if (requireSession(project.id, sessionId) === undefined) {
      return unknownSession(c, sessionId);
    }

    return c.body(createSseStream(grillMe, sessionId), 200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });

  app.post('/api/projects/:id/grill/:sessionId/answer', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const session = requireSession(project.id, c.req.param('sessionId'));
    if (session === undefined) {
      return unknownSession(c, c.req.param('sessionId'));
    }

    const input = await body(c);
    const result = await grillMe.submitAnswer(
      session.sessionId,
      asString(input.answer ?? input.text),
    );
    return result.ok
      ? c.json({ ok: true })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/grill/:sessionId/refine', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const session = requireSession(project.id, c.req.param('sessionId'));
    if (session === undefined) {
      return unknownSession(c, c.req.param('sessionId'));
    }

    const input = await body(c);
    const result = await grillMe.refineIssues(
      session.sessionId,
      asString(input.feedback ?? input.text),
    );
    return result.ok
      ? c.json({ ok: true })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/grill/:sessionId/cancel', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const session = requireSession(project.id, c.req.param('sessionId'));
    if (session === undefined) {
      return unknownSession(c, c.req.param('sessionId'));
    }

    const result = await grillMe.cancelSession(session.sessionId);
    if (result.ok) {
      sessionsById.delete(session.sessionId);
      sessionsByProject.delete(project.id);
    }
    return result.ok
      ? c.json({ ok: true })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  return app;
}
