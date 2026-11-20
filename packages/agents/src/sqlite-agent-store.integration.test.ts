/// <reference types="bun" />
import { Database } from 'bun:sqlite';
import * as bunTest from 'bun:test';
import { createSqliteAgentStore, type SqliteDatabase } from './sqlite-agent-store';
import { agentStoreContract, type StoreTestApi } from './store-contract';

/**
 * Holds the SQLite store to the same contract as the in-memory store. It runs
 * under `bun test` (not vitest) because `bun:sqlite` is Bun-only; see the
 * package's `test:integration` script.
 */
agentStoreContract(bunTest as unknown as StoreTestApi, () =>
  createSqliteAgentStore(new Database(':memory:') as unknown as SqliteDatabase),
);

/**
 * A database created before token usage existed, with one finished run.
 *
 * The token columns must be added in place so deploying over an existing
 * installation does not lose the run history.
 */
bunTest.describe('token columns on an existing database', () => {
  bunTest.it('adds the columns and leaves old runs unmeasured', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE agent_runs (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL,
        issue_id       TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'implement-issue',
        attempt_number INTEGER NOT NULL,
        pull_number    INTEGER,
        commit_sha     TEXT,
        job_name       TEXT,
        pvc_name       TEXT,
        openrouter_secret_name TEXT,
        branch         TEXT,
        review_feedback TEXT,
        status         TEXT NOT NULL,
        model          TEXT,
        pr_url         TEXT,
        review_verdict TEXT,
        review_body    TEXT,
        logs           TEXT,
        cost_cents     INTEGER NOT NULL,
        token_hash     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        started_at     TEXT,
        finished_at    TEXT
      );
    `);
    database
      .prepare(
        `INSERT INTO agent_runs
           (id, project_id, issue_id, attempt_number, status, cost_cents, token_hash, created_at)
         VALUES ('old-run', 'project-1', 'issue-1', 1, 'success', 12, 'hash-1', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const store = createSqliteAgentStore(database as unknown as SqliteDatabase);

    bunTest.expect(store.get('old-run')?.tokens).toBeNull();

    const tokens = {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 300, write: 10 },
    };
    store.create({
      id: 'new-run',
      projectId: 'project-1',
      issueId: 'issue-1',
      kind: 'implement-issue',
      attemptNumber: 2,
      pullNumber: null,
      commitSha: null,
      jobName: null,
      pvcName: null,
      openrouterSecretName: null,
      branch: null,
      reviewFeedback: null,
      status: 'success',
      model: 'openrouter/chosen',
      prUrl: null,
      reviewVerdict: null,
      reviewBody: null,
      logs: null,
      costCents: 10,
      tokens,
      createdAt: '2026-01-02T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      tokenHash: 'hash-2',
    });

    bunTest.expect(store.get('new-run')?.tokens).toEqual(tokens);
  });
});
