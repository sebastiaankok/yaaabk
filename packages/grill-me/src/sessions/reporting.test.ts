import { createInMemoryIssueStore, createIssuesModule, type IssuesModule } from '@yaaabk/issues';
import { createInMemoryPlanStore, createPlansModule } from '@yaaabk/plans';
import { describe, expect, it } from 'vitest';
import { createFakeSessionKeys, createFakeSessionRuntime } from './fake-runtime';
import {
  createGrillSessionsModule,
  type GrillSessionsModule,
  type StartGrillSessionInput,
} from './session';

const INPUT: StartGrillSessionInput = {
  projectId: 'p1',
  projectName: 'todo-app',
  idea: 'A todo app',
  skillLevel: 'expert',
};

interface Setup {
  sessions: GrillSessionsModule;
  runtime: ReturnType<typeof createFakeSessionRuntime>;
  plans: ReturnType<typeof createPlansModule>;
  issues: IssuesModule;
  keys: ReturnType<typeof createFakeSessionKeys>;
  /** Starts a session and returns its id and report token. */
  start(): Promise<{ id: string; token: string }>;
}

function setup(options: { issues?: IssuesModule } = {}): Setup {
  const runtime = createFakeSessionRuntime();
  const keys = createFakeSessionKeys();
  let sequence = 0;
  const plans = createPlansModule({
    store: createInMemoryPlanStore(),
    ids: () => `plan-${++sequence}`,
    clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
  });
  const issues =
    options.issues ??
    createIssuesModule({
      store: createInMemoryIssueStore(),
      ids: () => `issue-${++sequence}`,
      clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
    });
  const sessions = createGrillSessionsModule({
    runtime,
    plans,
    issues,
    defaultModel: 'openrouter/default-model',
    apiUrl: 'http://backend.internal:3000',
    keys,
    ids: () => `session-${++sequence}`,
    tokens: () => `report-token-${++sequence}`,
    clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
    logger: { info: () => {}, error: () => {} },
  });

  return {
    sessions,
    runtime,
    plans,
    issues,
    keys,
    async start() {
      const started = await sessions.start(INPUT);
      if (!started.ok) throw new Error(started.error.message);
      const request = runtime.requests.at(-1);
      if (request === undefined) throw new Error('no runtime request');
      return { id: started.value.id, token: request.reportToken ?? '' };
    },
  };
}

const PRD = '# Personal Bookmarks\n\nSave links and find them again.';
const ISSUES = [
  {
    title: 'Save a bookmark',
    body: 'A form that persists a bookmark.',
    summary: 'Save a bookmark for later.',
    labels: ['ready'],
    depends_on: [],
  },
];

describe('reporting session drafts', () => {
  it('rejects a Plan report without a valid summary', async () => {
    const { sessions, start } = setup();
    const { id, token } = await start();

    const missing = await sessions.report(id, token, { prd: PRD });
    const empty = await sessions.report(id, token, { prd: PRD, summary: '   ' });
    const tooLong = await sessions.report(id, token, { prd: PRD, summary: 'x'.repeat(201) });

    for (const reported of [missing, empty, tooLong]) {
      expect(reported.ok).toBe(false);
      if (!reported.ok) {
        expect(reported.error.kind).toBe('invalid-input');
        expect(reported.error.message).toContain('summary');
      }
    }
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.draft).toEqual({ hasPrd: false, issueCount: 0 });
  });

  it('stores a reported PRD as a draft without creating a Plan', async () => {
    const { sessions, plans, start } = setup();
    const { id, token } = await start();

    const reported = await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });

    expect(reported.ok).toBe(true);
    if (reported.ok) expect(reported.value.draft).toEqual({ hasPrd: true, issueCount: 0 });
    const stored = await plans.list('p1');
    expect(stored.ok && stored.value).toEqual([]);
  });

  it('rejects a missing or wrong bearer token', async () => {
    const { sessions, start } = setup();
    const { id } = await start();

    const missing = await sessions.report(id, '', { prd: PRD, summary: 'A plan.' });
    const wrong = await sessions.report(id, 'not-the-token', { prd: PRD, summary: 'A plan.' });

    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('unauthorized');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.kind).toBe('unauthorized');
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.draft).toEqual({ hasPrd: false, issueCount: 0 });
  });

  it('rejects Issues reported without a PRD draft', async () => {
    const { sessions, start } = setup();
    const { id, token } = await start();

    const reported = await sessions.report(id, token, { issues: ISSUES });

    expect(reported.ok).toBe(false);
    if (!reported.ok) {
      expect(reported.error.kind).toBe('invalid-input');
      expect(reported.error.message).toBe('Report a Plan before its issues');
    }
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.draft).toEqual({ hasPrd: false, issueCount: 0 });
  });

  it('replaces drafts on a repeated report instead of accumulating', async () => {
    const { sessions, start } = setup();
    const { id, token } = await start();

    await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });
    const first = await sessions.report(id, token, { issues: ISSUES });
    const second = await sessions.report(id, token, {
      prd: '# Revised PRD',
      summary: 'A revised plan.',
      issues: [...ISSUES, { ...ISSUES[0], title: 'List bookmarks' }],
    });

    expect(first.ok && first.value.draft.issueCount).toBe(1);
    expect(second.ok && second.value.draft).toEqual({ hasPrd: true, issueCount: 2 });
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.draft).toEqual({ hasPrd: true, issueCount: 2 });
  });

  it('rejects a malformed issue list without storing either draft', async () => {
    const { sessions, start } = setup();
    const { id, token } = await start();

    const reported = await sessions.report(id, token, {
      prd: PRD,
      summary: 'A plan.',
      issues: [{ title: '  ', summary: 'A summary.' }],
    });

    expect(reported.ok).toBe(false);
    if (!reported.ok) expect(reported.error.message).toContain('title');
    const current = await sessions.get('p1', id);
    expect(current.ok && current.value.draft).toEqual({ hasPrd: false, issueCount: 0 });
  });

  it('reports the session status to the same bearer token and rejects a wrong one', async () => {
    const { sessions, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });

    const current = await sessions.status(id, token);
    const denied = await sessions.status(id, 'wrong');

    expect(current.ok && current.value.draft.hasPrd).toBe(true);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe('unauthorized');
  });

  it('hands the runtime its report token and API URL without exposing them in the view', async () => {
    const { runtime, sessions, start } = setup();
    const { id, token } = await start();

    const request = runtime.requests[0];
    expect(request?.apiUrl).toBe('http://backend.internal:3000');
    expect(request?.reportToken).toBe(token);
    expect(token).not.toBe('');
    const current = await sessions.get('p1', id);
    expect(current.ok).toBe(true);
    if (current.ok) expect(JSON.stringify(current.value)).not.toContain(token);
  });

  it('discards the drafts when the session is cancelled', async () => {
    const { sessions, plans, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.', issues: ISSUES });

    const cancelled = await sessions.cancel('p1', id);

    expect(cancelled.ok && cancelled.value.draft).toEqual({ hasPrd: false, issueCount: 0 });
    const stored = await plans.list('p1');
    expect(stored.ok && stored.value).toEqual([]);
  });
});

describe('finishing a session', () => {
  it('refuses to finish without a PRD or any Issues, naming what is missing', async () => {
    const { sessions, plans, start } = setup();
    const { id } = await start();

    const finished = await sessions.finish('p1', id);

    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.error.kind).toBe('incomplete');
      expect(finished.error.missing).toEqual(['prd', 'issues']);
      expect(finished.error.message).toBe('Cannot finish: a Plan and an issue list missing');
    }
    const stored = await plans.list('p1');
    expect(stored.ok && stored.value).toEqual([]);
  });

  it('names the missing issue list when only a PRD was reported', async () => {
    const { sessions, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });

    const finished = await sessions.finish('p1', id);

    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.error.kind).toBe('incomplete');
      expect(finished.error.missing).toEqual(['issues']);
    }
  });

  it('publishes a forced PRD-only session as a Plan without Issues', async () => {
    const { sessions, plans, issues, runtime, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });

    const finished = await sessions.finish('p1', id, { force: true });

    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(finished.value.plan.contentMarkdown).toBe(PRD);
      expect(finished.value.plan.summary).toBe('A plan.');
      expect(finished.value.plan.source).toBe('grill-me');
      expect(finished.value.issues).toEqual([]);
      expect(finished.value.session.status).toBe('finished');
      expect(finished.value.session.draft).toEqual({ hasPrd: false, issueCount: 0 });
    }
    const storedPlans = await plans.list('p1');
    expect(storedPlans.ok && storedPlans.value).toHaveLength(1);
    const storedIssues = await issues.list('p1');
    expect(storedIssues.ok && storedIssues.value).toEqual([]);
    expect(runtime.stopped.map((ref) => ref.sessionId)).toEqual([id]);
  });

  it('revokes the session key when it finishes', async () => {
    const { sessions, start, keys } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.' });

    await sessions.finish('p1', id, { force: true });

    expect(keys.revoked).toEqual(['hash-session-1']);
  });

  it('publishes one Plan version and its Issues, and a retried Finish is idempotent', async () => {
    const { sessions, plans, issues, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.', issues: ISSUES });

    const finished = await sessions.finish('p1', id);
    const retried = await sessions.finish('p1', id);

    expect(finished.ok).toBe(true);
    expect(retried.ok).toBe(true);
    if (!finished.ok || !retried.ok) return;
    expect(finished.value.plan.version).toBe(1);
    expect(finished.value.issues).toHaveLength(1);
    expect(finished.value.issues[0]?.planId).toBe(finished.value.plan.id);
    expect(finished.value.issues[0]?.summary).toBe('Save a bookmark for later.');
    expect(retried.value.plan.id).toBe(finished.value.plan.id);
    expect(retried.value.issues).toEqual(finished.value.issues);
    const storedPlans = await plans.list('p1');
    expect(storedPlans.ok && storedPlans.value).toHaveLength(1);
    const storedIssues = await issues.list('p1');
    expect(storedIssues.ok && storedIssues.value).toHaveLength(1);
  });

  it('publishes one Plan version when two Finish calls race', async () => {
    const { sessions, plans, issues, start } = setup();
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.', issues: ISSUES });

    const [first, second] = await Promise.all([
      sessions.finish('p1', id),
      sessions.finish('p1', id),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.plan.id).toBe(first.value.plan.id);
    const storedPlans = await plans.list('p1');
    expect(storedPlans.ok && storedPlans.value).toHaveLength(1);
    const storedIssues = await issues.list('p1');
    expect(storedIssues.ok && storedIssues.value).toHaveLength(1);
  });

  it('keeps its drafts and reuses the Plan when publishing the Issues fails', async () => {
    let failOnce = true;
    const base = createIssuesModule({
      store: createInMemoryIssueStore(),
      ids: () => 'issue-1',
      clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
    });
    const failing: IssuesModule = {
      ...base,
      replaceForPlan(...args) {
        if (failOnce) {
          failOnce = false;
          return Promise.resolve({
            ok: false,
            error: { kind: 'unknown', operation: 'replaceForPlan', message: 'publish broke' },
          });
        }
        return base.replaceForPlan(...args);
      },
    };
    const { sessions, plans, start } = setup({ issues: failing });
    const { id, token } = await start();
    await sessions.report(id, token, { prd: PRD, summary: 'A plan.', issues: ISSUES });

    const failed = await sessions.finish('p1', id);

    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.kind).toBe('publish-failed');
    const afterFailure = await sessions.get('p1', id);
    expect(afterFailure.ok && afterFailure.value.status).toBe('active');
    expect(afterFailure.ok && afterFailure.value.draft).toEqual({ hasPrd: true, issueCount: 1 });
    const plansAfterFailure = await plans.list('p1');
    expect(plansAfterFailure.ok && plansAfterFailure.value).toHaveLength(1);

    const retried = await sessions.finish('p1', id);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    const plansAfterRetry = await plans.list('p1');
    expect(plansAfterRetry.ok && plansAfterRetry.value).toHaveLength(1);
    expect(retried.value.plan.id).toBe(plansAfterFailure.ok ? plansAfterFailure.value[0]?.id : '');
    expect(retried.value.issues).toHaveLength(1);
  });
});
