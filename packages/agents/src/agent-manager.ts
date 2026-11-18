import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { GitHubIssues } from '@yaaabk/github';
import type { Issue, IssuesModule } from '@yaaabk/issues';
import type { K8sClient, JobSpec, PodInfo } from '@yaaabk/k8s';
import {
  DEPLOY_SOURCE_PATH,
  PROJECT_AGENT_SERVICE_ACCOUNT,
  PROJECT_DEPLOY_SERVICE_ACCOUNT,
  type Project,
  type ProjectStore,
} from '@yaaabk/projects';
import {
  AGENT_CONTAINER_SECURITY_CONTEXT,
  AGENT_POD_SECURITY_CONTEXT,
  DEFAULT_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_AGENT_IMAGE,
  DEFAULT_AGENT_MODEL,
  DEFAULT_MAX_CONCURRENT_CLUSTER,
  DEFAULT_MAX_CONCURRENT_PER_PROJECT,
  DEFAULT_PVC_STORAGE,
  DEPLOY_FAILED_LABEL,
  IMPLEMENT_SKILL_PATH,
  OPENROUTER_SECRET_KEY,
  REVIEW_SKILL_PATH,
  WORKSPACE_MOUNT_PATH,
  WORKSPACE_VOLUME_NAME,
  githubTokenSecretName,
  jobName,
  openrouterSecretName,
  pvcName,
} from './config';
import { agentsError, consoleLogger, toAgentsError, type AgentsLogger } from './errors';
import type {
  AgentGithubTokenResolver,
  AgentLogOptions,
  AgentManager,
  AgentReport,
  AgentRun,
  AgentRunKind,
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
  /**
   * Mirrors a failed deploy onto the Issue as a `deploy-failed` label. Optional
   * so the manager still works without GitHub credentials; the failure is
   * always recorded on the Project and its run regardless.
   */
  githubIssues?: GitHubIssues;
  /** Agent container image. Defaults to {@link DEFAULT_AGENT_IMAGE}. */
  image?: string;
  /**
   * OpenCode model Agent Jobs invoke when neither the Issue nor the Project
   * chooses one, in `provider/model` form. Defaults to
   * {@link DEFAULT_AGENT_MODEL}; the backend passes the same environment
   * default Grill-Me Sessions fall back to.
   */
  model?: string;
  /** Cap on Agents running for one Project. Defaults to 2. */
  maxPerProject?: number;
  /** Cap on Agents running cluster-wide. Defaults to 10. */
  maxCluster?: number;
  /** Storage requested for a working PVC. Defaults to `1Gi`. */
  pvcStorage?: string;
  /**
   * StorageClass the working PVC requests. Omit to use the cluster's default
   * StorageClass; a cluster without one cannot bind the claim.
   */
  storageClassName?: string;
  /** Seconds an attempt may run before it is killed. Defaults to 30 minutes. */
  activeDeadlineSeconds?: number;
  /** Base URL the Job reports back to, exposed to it as `YAAABK_API_URL`. */
  apiUrl?: string;
  /**
   * GitHub token each run clones with, written to a per-run Secret in the agent
   * namespace. Prefer a short-lived App installation token; when omitted the
   * Job simply gets no `GITHUB_TOKEN`.
   *
   * A function is asked for a token scoped to the run's kind: implement-issue
   * runs push and open pull requests, review runs only clone and post a review.
   */
  githubToken?: string | AgentGithubTokenResolver;
  /**
   * Mints the budgeted OpenRouter key a run uses when the caller supplies none.
   * Retries and CI-tracker fix attempts go through the same resolver, so a run
   * never starts without a credential. Deploy runs are skipped: they apply
   * manifests rather than call an LLM.
   */
  mintOpenrouterKey?: (issue: Issue, attemptNumber: number) => Promise<AgentOpenrouterKeyResult>;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable id generator. Defaults to `crypto.randomUUID`. */
  ids?: () => string;
  /** Injectable report-token generator. Defaults to 32 random bytes, hex. */
  newToken?: () => string;
  logger?: AgentsLogger;
}

/** A freshly minted OpenRouter key, or why it could not be minted. */
export type AgentOpenrouterKeyResult =
  { ok: true; key: string; hash: string } | { ok: false; message: string };

/** SHA-256 hex of a report token, the only form the store keeps. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The label Kubernetes puts on every Pod a Job creates. */
const JOB_POD_LABEL = 'job-name';

/** Cap on captured failure output, so a chatty run cannot fill the store. */
const MAX_FAILURE_LOG_CHARS = 200_000;

/** How long a reconcile pass waits for a dead Pod's log before moving on. */
const FAILURE_LOG_READ_TIMEOUT_MS = 5_000;

/** A stream that yields `text` once and closes. */
function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== '') {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
}

/** Reads a byte stream to text, keeping only the last `limit` characters. */
async function readStreamText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // A dead Job's log endpoint can hang open; stop reading and keep what arrived.
  const timer = setTimeout(() => {
    void reader.cancel().catch(() => undefined);
  }, FAILURE_LOG_READ_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) text = text.slice(-limit);
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}

/** Strips the report-token hash, leaving what callers may see. */
function toPublicRun(run: StoredAgentRun): AgentRun {
  return {
    id: run.id,
    projectId: run.projectId,
    issueId: run.issueId,
    kind: run.kind,
    attemptNumber: run.attemptNumber,
    pullNumber: run.pullNumber,
    commitSha: run.commitSha,
    reviewFeedback: run.reviewFeedback,
    jobName: run.jobName,
    pvcName: run.pvcName,
    openrouterSecretName: run.openrouterSecretName,
    branch: run.branch,
    status: run.status,
    model: run.model,
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
  const defaultModel = options.model?.trim() || DEFAULT_AGENT_MODEL;
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
      'yaaabk.io/run-kind': run.kind,
    };
  }

  /** The run's GitHub token, scoped to what its kind needs. */
  async function githubTokenFor(kind: AgentRunKind): Promise<string | undefined> {
    const configured = options.githubToken;
    if (configured === undefined) return undefined;
    const token = typeof configured === 'function' ? await configured(kind) : configured;
    return token === '' ? undefined : token;
  }

  /** The Pod a run's Job created, once the scheduler has placed it. */
  async function jobPod(namespace: string, jobName: string): Promise<PodInfo | undefined> {
    const pods = await k8s.pods.list(namespace, { [JOB_POD_LABEL]: jobName });
    if (!pods.ok) return undefined;
    // A Job runs one Pod at a time, so the newest is the only candidate.
    return pods.value.at(-1);
  }

  /**
   * Captures why a run's Pod stopped and what it printed last.
   *
   * A Pod killed by the kubelet — notably an `OOMKilled` one — never reaches
   * its own error handling, so it reports nothing. Without this the run is
   * marked failed with an empty log and no clue; the kubelet still has the
   * container's output and termination reason, so read those here.
   */
  async function failureLogs(namespace: string, run: StoredAgentRun): Promise<string | undefined> {
    if (run.jobName === null) return undefined;
    const pod = await jobPod(namespace, run.jobName);
    if (pod === undefined) return undefined;

    const parts: string[] = [];
    if (pod.terminationReason !== null) {
      const exit = pod.exitCode === null ? '' : ` (exit code ${pod.exitCode})`;
      parts.push(`Pod ${pod.name} terminated: ${pod.terminationReason}${exit}`);
    }
    const stream = await k8s.pods.logs(namespace, pod.name, { tailLines: 400 });
    if (stream.ok) {
      const output = await readStreamText(stream.value, MAX_FAILURE_LOG_CHARS);
      if (output.trim() !== '') parts.push(output.trimEnd());
    }
    return parts.length === 0 ? undefined : parts.join('\n\n');
  }

  /**
   * Labels the Issue whose deploy failed, leaving the Issue itself closed.
   *
   * Best-effort: GitHub being unreachable must not lose the deploy failure that
   * has already been recorded on the Project and run.
   */
  async function labelDeployFailure(project: Project, issue: Issue): Promise<void> {
    const github = options.githubIssues;
    if (github === undefined || issue.githubNumber === null) return;
    try {
      const ensured = await github.ensureLabels(project.repoFullName, [DEPLOY_FAILED_LABEL]);
      if (!ensured.ok) {
        logger.error('agents deploy label failed', {
          projectId: project.id,
          issueId: issue.id,
          kind: ensured.error.kind,
        });
        return;
      }
      const current = await github.getIssue(project.repoFullName, issue.githubNumber);
      if (!current.ok) {
        logger.error('agents deploy label read failed', {
          projectId: project.id,
          issueId: issue.id,
          kind: current.error.kind,
        });
        return;
      }
      if (current.value.labels.includes(DEPLOY_FAILED_LABEL)) return;
      const updated = await github.updateIssue(project.repoFullName, issue.githubNumber, {
        labels: [...current.value.labels, DEPLOY_FAILED_LABEL],
      });
      if (!updated.ok) {
        logger.error('agents deploy label update failed', {
          projectId: project.id,
          issueId: issue.id,
          kind: updated.error.kind,
        });
      }
    } catch (error) {
      logger.error('agents deploy label failed', {
        projectId: project.id,
        issueId: issue.id,
        error: String(error),
      });
    }
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
      // Agent Jobs run in the Project's own namespace as `yaaabk-agent`; deploy
      // Jobs run in the Project's namespace as `yaaabk-deploy`.
      const isDeploy = run.kind === 'deploy';
      const namespace = project.namespace;
      // Resolve per-issue, then per-project, then the environment default. A
      // queued run therefore picks up settings as they are when it dispatches.
      const runModel = isDeploy ? null : (issue.agentModel ?? project.agentModel ?? defaultModel);
      const labels = runLabels(run);
      const pvc = isDeploy ? null : pvcName(run.issueId, run.attemptNumber, run.kind);
      const job = jobName(run.issueId, run.attemptNumber, run.kind);
      if (issue.githubNumber === null) {
        throw agentsError('issue-not-synced', `Issue "${run.issueId}" has no GitHub number yet`);
      }
      if (run.kind === 'review' && run.pullNumber === null) {
        throw agentsError('invalid-input', `Review run "${run.id}" has no pull number`);
      }
      if (isDeploy && run.commitSha === null) {
        throw agentsError('invalid-input', `Deploy run "${run.id}" has no commit SHA`);
      }

      if (pvc !== null) {
        const pvcResult = await k8s.pvcs.create(namespace, pvc, {
          storage: pvcStorage,
          labels,
          ...(options.storageClassName === undefined
            ? {}
            : { storageClassName: options.storageClassName }),
        });
        if (!pvcResult.ok) {
          throw agentsError('kubernetes', `pvcs.create failed: ${pvcResult.error.message}`);
        }
      }

      const token = newToken();
      const env: Record<string, string> = {
        AGENT_RUN_KIND: run.kind,
        ISSUE_NUMBER: String(issue.githubNumber),
        REPO_URL: project.repoUrl,
        MAX_ATTEMPTS: String(issue.maxAttempts),
        AGENT_RUN_ID: run.id,
        AGENT_RUN_TOKEN: token,
        ...(isDeploy
          ? {}
          : {
              AGENT_MODEL: runModel ?? defaultModel,
              YAAABK_SKILL_PATH: run.kind === 'review' ? REVIEW_SKILL_PATH : IMPLEMENT_SKILL_PATH,
            }),
      };
      if (options.apiUrl !== undefined) {
        env.YAAABK_API_URL = options.apiUrl;
      }
      if (run.branch !== null) {
        env.BRANCH = run.branch;
      } else if (isDeploy) {
        env.BRANCH = 'main';
      }
      if (run.pullNumber !== null) {
        env.PULL_NUMBER = String(run.pullNumber);
      }
      if (run.reviewFeedback !== null) {
        env.REVIEW_FEEDBACK = run.reviewFeedback;
      }
      if (isDeploy && run.commitSha !== null) {
        env.COMMIT_SHA = run.commitSha;
        env.DEPLOY_NAMESPACE = namespace;
        env.DEPLOY_PATH = DEPLOY_SOURCE_PATH;
        env.DEPLOYMENT_NAME = project.name;
      }
      const envFrom: JobSpec['envFrom'] = [];
      const githubToken = await githubTokenFor(run.kind);
      if (githubToken !== undefined) {
        // A fresh token per run, in its own short-lived Secret: nothing
        // long-lived with repository access is ever copied around.
        const githubSecret = githubTokenSecretName(run.issueId, run.attemptNumber, run.kind);
        const githubResult = await k8s.secrets.create(namespace, githubSecret, {
          GITHUB_TOKEN: githubToken,
        });
        if (!githubResult.ok) {
          throw agentsError('kubernetes', `secrets.create failed: ${githubResult.error.message}`);
        }
        envFrom.push({ secretRef: { name: githubSecret } });
      }
      if (run.openrouterSecretName !== null) {
        envFrom.push({ secretRef: { name: run.openrouterSecretName } });
      }

      const volumes: NonNullable<JobSpec['volumes']> =
        pvc === null
          ? [{ name: WORKSPACE_VOLUME_NAME, emptyDir: {} }]
          : [{ name: WORKSPACE_VOLUME_NAME, persistentVolumeClaim: { claimName: pvc } }];

      const jobResult = await k8s.jobs.create(namespace, job, {
        image,
        env,
        envFrom,
        serviceAccountName: isDeploy
          ? PROJECT_DEPLOY_SERVICE_ACCOUNT
          : PROJECT_AGENT_SERVICE_ACCOUNT,
        volumes,
        volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
        activeDeadlineSeconds,
        backoffLimit: 0,
        labels,
        resources: {
          requests: { cpu: '500m', memory: '512Mi' },
          // OpenCode's server keeps a session's state in memory and grew past
          // 1Gi a few minutes into a healthy run, so the kubelet OOM-killed it
          // with nothing reported. 2Gi/2 CPUs leave headroom for a full
          // attempt, including the project's own test and typecheck runs.
          limits: { cpu: '2', memory: '2Gi' },
        },
        podSecurityContext: AGENT_POD_SECURITY_CONTEXT,
        containerSecurityContext: AGENT_CONTAINER_SECURITY_CONTEXT,
      });
      if (!jobResult.ok) {
        throw agentsError('kubernetes', `jobs.create failed: ${jobResult.error.message}`);
      }

      const running: StoredAgentRun = {
        ...run,
        jobName: job,
        pvcName: pvc,
        status: 'running',
        model: runModel,
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

  /** Marks a run terminal and decides whether to retry or escalate. */
  async function failRun(run: StoredAgentRun, summary: ReconcileSummary): Promise<void> {
    const finishedAt = now().toISOString();

    // Capture the dead Pod's output before recording the failure: a run killed
    // by the kubelet (OOMKilled, evicted) never reports, and this is the only
    // clue the Developer gets.
    let logs = run.logs;
    const project = projects.get(run.projectId);
    if (project !== undefined) {
      try {
        const captured = await failureLogs(project.namespace, run);
        if (captured !== undefined) logs = captured;
      } catch (error) {
        logger.error('agents failure log capture failed', {
          runId: run.id,
          jobName: run.jobName,
          error: String(error),
        });
      }
    }

    store.update({ ...run, status: 'failed', finishedAt, logs });
    summary.failed += 1;

    if (run.kind === 'deploy') {
      // A failed deploy does not retry automatically or reopen the Issue (see #59).
      return;
    }

    const issue = await requireIssue(run.projectId, run.issueId);

    if (run.kind === 'review') {
      // A review run retries like any other, but never changes the Issue: the
      // CI Tracker owns the merge decision and decides what a missing review
      // means.
      const reviews = store
        .listForIssue(run.projectId, run.issueId)
        .filter((candidate) => candidate.kind === 'review');
      if (reviews.length < issue.maxAttempts) {
        const retry = await schedule(run.projectId, run.issueId, {
          kind: 'review',
          ...(run.pullNumber === null ? {} : { pullNumber: run.pullNumber }),
          ...(run.branch === null ? {} : { branch: run.branch }),
        });
        if (retry.status === 'running') {
          summary.dispatched += 1;
        }
      }
      return;
    }

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
   * Records a run for an Issue and creates its record. An implement-issue run
   * consumes one of the Issue's attempts; review and deploy runs do not, so
   * neither reviewing nor deploying can spend the implement budget.
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

    const kind = spawnOptions.kind ?? 'implement-issue';
    if (kind === 'review') {
      if (spawnOptions.pullNumber === undefined) {
        throw agentsError('invalid-input', 'A review run requires the pull request number');
      }
      if (spawnOptions.branch === undefined) {
        throw agentsError('invalid-input', 'A review run requires the pull request branch');
      }
    }
    if (
      kind === 'deploy' &&
      (spawnOptions.commitSha === undefined || spawnOptions.commitSha.trim() === '')
    ) {
      throw agentsError('invalid-input', 'A deploy run requires the merged commit SHA');
    }

    const attemptNumber =
      kind === 'review' || kind === 'deploy'
        ? store.listForIssue(projectId, issueId).filter((run) => run.kind === kind).length + 1
        : issue.attemptCount + 1;

    let openrouterApiKey = spawnOptions.openrouterApiKey;
    let openrouterKeyHash: string | undefined;
    if (
      openrouterApiKey === undefined &&
      kind !== 'deploy' &&
      options.mintOpenrouterKey !== undefined
    ) {
      const minted = await options.mintOpenrouterKey(issue, attemptNumber);
      if (!minted.ok) {
        throw agentsError('unknown', minted.message);
      }
      openrouterApiKey = minted.key;
      openrouterKeyHash = minted.hash;
    }

    let secret: string | null = null;
    if (openrouterApiKey !== undefined) {
      secret = openrouterSecretName(issueId, attemptNumber, kind);
      const secretResult = await k8s.secrets.create(project.namespace, secret, {
        [OPENROUTER_SECRET_KEY]: openrouterApiKey,
      });
      if (!secretResult.ok) {
        throw agentsError('kubernetes', `secrets.create failed: ${secretResult.error.message}`);
      }
    }

    const run: StoredAgentRun = {
      id: newId(),
      projectId,
      issueId,
      kind,
      attemptNumber,
      pullNumber: spawnOptions.pullNumber ?? null,
      commitSha: spawnOptions.commitSha ?? null,
      reviewFeedback: spawnOptions.reviewFeedback ?? null,
      jobName: null,
      pvcName: null,
      openrouterSecretName: secret,
      branch: spawnOptions.branch ?? null,
      status: 'queued',
      model: null,
      prUrl: null,
      logs: null,
      costCents: 0,
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      tokenHash: '',
    };
    store.create(run);

    if (kind === 'implement-issue') {
      await issues.update(projectId, issueId, {
        status: 'in_progress',
        attemptCount: attemptNumber,
        ...(openrouterKeyHash === undefined ? {} : { openrouterKeyHash }),
      });
    } else if (openrouterKeyHash !== undefined) {
      await issues.update(projectId, issueId, { openrouterKeyHash });
    }

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
          ...(report.commitSha === undefined ? {} : { commitSha: report.commitSha }),
        };
        store.update(updated);

        if (run.kind === 'deploy' && report.deployOutcome !== undefined) {
          const project = projects.get(run.projectId);
          if (project !== undefined) {
            const at = now().toISOString();
            // Only a successful deploy advances the deployed commit; a failure
            // keeps the last good one so the rollback is what stayed live.
            const deployedCommitSha =
              report.deployOutcome === 'success' && report.commitSha !== undefined
                ? report.commitSha
                : project.deployedCommitSha;
            projects.update({
              ...project,
              deployedCommitSha,
              lastDeployStatus: report.deployOutcome,
              lastDeployAt: at,
              updatedAt: at,
            });
            if (report.deployOutcome === 'failed') {
              const issue = await requireIssue(run.projectId, run.issueId);
              await labelDeployFailure(project, issue);
            }
          }
        }

        return toPublicRun(updated);
      });
    },

    logs(runId, logOptions: AgentLogOptions = {}) {
      return guard('logs', { runId }, async () => {
        const run = store.get(runId);
        if (run === undefined) {
          throw agentsError('not-found', `No agent run with id "${runId}"`);
        }
        // A finished run has no Pod left to follow; its stored log is the record.
        if (run.status !== 'running' || run.jobName === null) {
          return textStream(run.logs ?? '');
        }
        const project = projects.get(run.projectId);
        if (project === undefined) {
          throw agentsError('not-found', `No project with id "${run.projectId}"`);
        }
        const pod = await jobPod(project.namespace, run.jobName);
        if (pod === undefined) {
          // The Job exists but the scheduler has not placed its Pod yet.
          return textStream(run.logs ?? '');
        }
        const result = await k8s.pods.logs(project.namespace, pod.name, {
          follow: logOptions.follow ?? true,
          tailLines: logOptions.tailLines ?? 500,
        });
        if (!result.ok) {
          throw agentsError('kubernetes', `pods.logs failed: ${result.error.message}`);
        }
        return result.value;
      });
    },
  };
}
