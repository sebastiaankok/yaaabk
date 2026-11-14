import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Issue, IssuesModule } from '@yaaabk/issues';
import type { K8sClient, JobSpec } from '@yaaabk/k8s';
import {
  PROJECT_AGENT_SERVICE_ACCOUNT,
  PROJECT_GITHUB_SECRET,
  type ProjectStore,
} from '@yaaabk/projects';
import {
  DEFAULT_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_AGENT_IMAGE,
  DEFAULT_MAX_CONCURRENT_CLUSTER,
  DEFAULT_MAX_CONCURRENT_PER_PROJECT,
  DEFAULT_PVC_STORAGE,
  OPENROUTER_SECRET_KEY,
  WORKSPACE_MOUNT_PATH,
  WORKSPACE_VOLUME_NAME,
  jobName,
  openrouterSecretName,
  pvcName,
} from './config';
import { agentsError, consoleLogger, toAgentsError, type AgentsLogger } from './errors';
import type {
  AgentManager,
  AgentReport,
  AgentRun,
  AgentStore,
  AgentsResult,
  Capacity,
  ReconcileSummary,
  SpawnOptions,
  StoredAgentRun,
} from './types';

export interface AgentManagerOptions {
  store: AgentStore;
  /** Reads and updates the Issues the Agents work on. */
  issues: IssuesModule;
  /** Resolves a Project's namespace and repository URL. */
  projects: ProjectStore;
  /** Creates the Jobs, PVCs and Secrets. */
  k8s: K8sClient;
  /** Agent container image. Defaults to {@link DEFAULT_AGENT_IMAGE}. */
  image?: string;
  /** Cap on Agents running for one Project. Defaults to 2. */
  maxPerProject?: number;
  /** Cap on Agents running cluster-wide. Defaults to 10. */
  maxCluster?: number;
  /** Storage requested for a working PVC. Defaults to `1Gi`. */
  pvcStorage?: string;
  /** Seconds an attempt may run before it is killed. Defaults to 30 minutes. */
  activeDeadlineSeconds?: number;
  /** Base URL the Job reports back to, exposed to it as `YAAABK_API_URL`. */
  apiUrl?: string;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable id generator. Defaults to `crypto.randomUUID`. */
  ids?: () => string;
  /** Injectable report-token generator. Defaults to 32 random bytes, hex. */
  newToken?: () => string;
  logger?: AgentsLogger;
}

/** SHA-256 hex of a report token, the only form the store keeps. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Strips the report-token hash, leaving what callers may see. */
function toPublicRun(run: StoredAgentRun): AgentRun {
  return {
    id: run.id,
    projectId: run.projectId,
    issueId: run.issueId,
    attemptNumber: run.attemptNumber,
    jobName: run.jobName,
    pvcName: run.pvcName,
    openrouterSecretName: run.openrouterSecretName,
    branch: run.branch,
    status: run.status,
    prUrl: run.prUrl,
    logs: run.logs,
    costCents: run.costCents,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/** Builds the public Agent Manager. */
export function createAgentManager(options: AgentManagerOptions): AgentManager {
  const { store, issues, projects, k8s } = options;
  const logger = options.logger ?? consoleLogger;
  const now = options.clock ?? (() => new Date());
  const newId = options.ids ?? randomUUID;
  const newToken = options.newToken ?? (() => randomBytes(32).toString('hex'));
  const image = options.image ?? DEFAULT_AGENT_IMAGE;
  const maxPerProject = options.maxPerProject ?? DEFAULT_MAX_CONCURRENT_PER_PROJECT;
  const maxCluster = options.maxCluster ?? DEFAULT_MAX_CONCURRENT_CLUSTER;
  const pvcStorage = options.pvcStorage ?? DEFAULT_PVC_STORAGE;
  const activeDeadlineSeconds = options.activeDeadlineSeconds ?? DEFAULT_ACTIVE_DEADLINE_SECONDS;

  /**
   * Runs an operation, mapping failures to typed errors and logging every
   * attempt for auditability.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<AgentsResult<T>> {
    try {
      const value = await run();
      logger.info(`agents ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toAgentsError(operation, error);
      logger.error(`agents ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  /** The labels tying an attempt's resources back to its run. */
  function runLabels(run: StoredAgentRun): Record<string, string> {
    return {
      'yaaabk.io/project-id': run.projectId,
      'yaaabk.io/issue-id': run.issueId,
      'yaaabk.io/run-id': run.id,
    };
  }

  /** Running attempts per Project and cluster-wide. */
  function runningCounts(): { perProject: Map<string, number>; cluster: number } {
    const perProject = new Map<string, number>();
    let cluster = 0;
    for (const run of store.listActive()) {
      if (run.status !== 'running') continue;
      cluster += 1;
      perProject.set(run.projectId, (perProject.get(run.projectId) ?? 0) + 1);
    }
    return { perProject, cluster };
  }

  function canDispatch(projectId: string): boolean {
    const { perProject, cluster } = runningCounts();
    return (perProject.get(projectId) ?? 0) < maxPerProject && cluster < maxCluster;
  }

  async function requireIssue(projectId: string, issueId: string): Promise<Issue> {
    const result = await issues.get(projectId, issueId);
    if (!result.ok) {
      throw agentsError('not-found', result.error.message);
    }
    return result.value;
  }

  /**
   * Gives a queued attempt its PVC, Secret reference and Job, then records it
   * as running.
   *
   * The run is flipped to `running` synchronously, before the first `await`, so
   * a concurrent `spawn` or scheduling pass cannot also claim the same slot: the
   * concurrency limits are respected even when callers race.
   */
  async function dispatch(run: StoredAgentRun): Promise<StoredAgentRun> {
    const started = now().toISOString();
    store.update({ ...run, status: 'running', startedAt: started });
    try {
      const project = projects.get(run.projectId);
      if (project === undefined) {
        throw agentsError('not-found', `No project with id "${run.projectId}"`);
      }
      const issue = await requireIssue(run.projectId, run.issueId);
      const namespace = project.namespace;
      const labels = runLabels(run);
      const pvc = pvcName(run.issueId, run.attemptNumber);
      const job = jobName(run.issueId, run.attemptNumber);
      if (issue.githubNumber === null) {
        throw agentsError('issue-not-synced', `Issue "${run.issueId}" has no GitHub number yet`);
      }

      const pvcResult = await k8s.pvcs.create(namespace, pvc, { storage: pvcStorage, labels });
      if (!pvcResult.ok) {
        throw agentsError('kubernetes', `pvcs.create failed: ${pvcResult.error.message}`);
      }

      const token = newToken();
      const env: Record<string, string> = {
        ISSUE_NUMBER: String(issue.githubNumber),
        REPO_URL: project.repoUrl,
        MAX_ATTEMPTS: String(issue.maxAttempts),
        AGENT_RUN_ID: run.id,
        AGENT_RUN_TOKEN: token,
      };
      if (options.apiUrl !== undefined) {
        env.YAAABK_API_URL = options.apiUrl;
      }
      if (run.branch !== null) {
        env.BRANCH = run.branch;
      }
      const envFrom: JobSpec['envFrom'] = [{ secretRef: { name: PROJECT_GITHUB_SECRET } }];
      if (run.openrouterSecretName !== null) {
        envFrom.push({ secretRef: { name: run.openrouterSecretName } });
      }

      const jobResult = await k8s.jobs.create(namespace, job, {
        image,
        env,
        envFrom,
        serviceAccountName: PROJECT_AGENT_SERVICE_ACCOUNT,
        volumes: [{ name: WORKSPACE_VOLUME_NAME, persistentVolumeClaim: { claimName: pvc } }],
        volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
        activeDeadlineSeconds,
        backoffLimit: 0,
        labels,
        resources: {
          requests: { cpu: '500m', memory: '512Mi' },
          limits: { cpu: '1', memory: '1Gi' },
        },
      });
      if (!jobResult.ok) {
        throw agentsError('kubernetes', `jobs.create failed: ${jobResult.error.message}`);
      }

      const running: StoredAgentRun = {
        ...run,
        jobName: job,
        pvcName: pvc,
        status: 'running',
        startedAt: started,
        tokenHash: hashToken(token),
      };
      store.update(running);
      return running;
    } catch (error) {
      // Release the reserved slot so a later pass can retry the dispatch.
      store.update({ ...run, status: 'queued', startedAt: null });
      throw error;
    }
  }

  /** Dispatches the run only if the concurrency limits leave room. */
  async function dispatchIfCapacity(run: StoredAgentRun): Promise<StoredAgentRun> {
    return canDispatch(run.projectId) ? dispatch(run) : run;
  }

  /** Marks a run terminal and decides whether to retry or escalate its Issue. */
  async function failRun(run: StoredAgentRun, summary: ReconcileSummary): Promise<void> {
    const finishedAt = now().toISOString();
    store.update({ ...run, status: 'failed', finishedAt });
    summary.failed += 1;

    const issue = await requireIssue(run.projectId, run.issueId);
    if (issue.attemptCount < issue.maxAttempts) {
      const retry = await schedule(run.projectId, run.issueId);
      if (retry.status === 'running') {
        summary.dispatched += 1;
      }
      return;
    }

    await issues.update(run.projectId, run.issueId, { status: 'failed', label: 'needs-human' });
    summary.escalated += 1;
  }

  /**
   * Records an attempt for an Issue: increments its attempt count, marks it
   * in progress and creates the run record. Shared by {@link spawn} and retries.
   */
  async function schedule(projectId: string, issueId: string, spawnOptions: SpawnOptions = {}) {
    const project = projects.get(projectId);
    if (project === undefined) {
      throw agentsError('not-found', `No project with id "${projectId}"`);
    }
    const issue = await requireIssue(projectId, issueId);
    if (issue.githubNumber === null) {
      throw agentsError(
        'issue-not-synced',
        `Issue "${issueId}" has not been synced to GitHub yet, so an Agent cannot fetch it`,
      );
    }

    const attemptNumber = issue.attemptCount + 1;
    let secret: string | null = null;
    if (spawnOptions.openrouterApiKey !== undefined) {
      secret = openrouterSecretName(issueId, attemptNumber);
      const secretResult = await k8s.secrets.create(project.namespace, secret, {
        [OPENROUTER_SECRET_KEY]: spawnOptions.openrouterApiKey,
      });
      if (!secretResult.ok) {
        throw agentsError('kubernetes', `secrets.create failed: ${secretResult.error.message}`);
      }
    }

    const run: StoredAgentRun = {
      id: newId(),
      projectId,
      issueId,
      attemptNumber,
      jobName: null,
      pvcName: null,
      openrouterSecretName: secret,
      branch: spawnOptions.branch ?? null,
      status: 'queued',
      prUrl: null,
      logs: null,
      costCents: 0,
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      tokenHash: '',
    };
    store.create(run);

    await issues.update(projectId, issueId, {
      status: 'in_progress',
      attemptCount: attemptNumber,
    });

    return toPublicRun(await dispatchIfCapacity(run));
  }

  return {
    spawn(projectId, issueId, spawnOptions = {}) {
      return guard('spawn', { projectId, issueId }, async () =>
        schedule(projectId, issueId, spawnOptions),
      );
    },

    runs(projectId, issueId) {
      return guard('runs', { projectId, issueId }, async () =>
        store.listForIssue(projectId, issueId).map(toPublicRun),
      );
    },

    projectRuns(projectId) {
      return guard('projectRuns', { projectId }, async () =>
        store.listForProject(projectId).map(toPublicRun),
      );
    },

    reconcile() {
      return guard('reconcile', {}, async () => {
        const summary: ReconcileSummary = {
          dispatched: 0,
          succeeded: 0,
          failed: 0,
          escalated: 0,
        };

        for (const run of store.listActive()) {
          if (run.status !== 'running' || run.jobName === null) continue;
          const project = projects.get(run.projectId);
          if (project === undefined) continue;
          const job = await k8s.jobs.get(project.namespace, run.jobName);
          if (!job.ok) {
            if (job.error.kind === 'not-found') {
              await failRun(run, summary);
            }
            continue;
          }
          if (job.value.phase === 'succeeded') {
            store.update({ ...run, status: 'success', finishedAt: now().toISOString() });
            summary.succeeded += 1;
          } else if (job.value.phase === 'failed') {
            await failRun(run, summary);
          }
        }

        for (const run of store.listActive()) {
          if (run.status !== 'queued') continue;
          if (!canDispatch(run.projectId)) continue;
          try {
            await dispatch(run);
            summary.dispatched += 1;
          } catch (error) {
            logger.error('agents reconcile dispatch failed', {
              runId: run.id,
              error: String(error),
            });
          }
        }

        return summary;
      });
    },

    capacity(projectId) {
      const { perProject, cluster } = runningCounts();
      return {
        ok: true,
        value: {
          project: projectId === undefined ? 0 : (perProject.get(projectId) ?? 0),
          cluster,
          maxPerProject,
          maxCluster,
        } satisfies Capacity,
      };
    },

    report(runId, token, report: AgentReport) {
      return guard('report', { runId }, async () => {
        const run = store.get(runId);
        if (run === undefined) {
          throw agentsError('not-found', `No agent run with id "${runId}"`);
        }
        if (run.tokenHash === '' || hashToken(token) !== run.tokenHash) {
          throw agentsError('unauthorized', 'The report token is not valid for this run');
        }
        const updated: StoredAgentRun = {
          ...run,
          ...(report.prUrl === undefined ? {} : { prUrl: report.prUrl }),
          ...(report.costCents === undefined ? {} : { costCents: report.costCents }),
          ...(report.logs === undefined ? {} : { logs: report.logs }),
        };
        store.update(updated);
        return toPublicRun(updated);
      });
    },
  };
}
