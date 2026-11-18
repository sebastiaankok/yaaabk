/// <reference types="bun" />
import { join } from 'node:path';
import type { AgentConfig } from './config';
import type {
  AgentDependencies,
  AgentIssue,
  AgentPullRequest,
  Checks,
  Git,
  GitHub,
  Kubectl,
  OpenCode,
  Reporter,
  ReviewVerdict,
  SpendMeter,
} from './ports';
import { REVIEW_VERDICT_PATH } from './prompt';

/** Splits an `https://github.com/<owner>/<repo>` URL into its parts. */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const path = repoUrl
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .split('/')
    .slice(-2);
  const [owner, repo] = path;
  if (owner === undefined || repo === undefined) {
    throw new Error(`Cannot parse repository URL: ${repoUrl}`);
  }
  return { owner, repo };
}

/** The real `git` adapter, shelling out to the CLI. */
export function createGit(): Git {
  return {
    async clone({ repoUrl, token, directory }) {
      const authed = repoUrl.replace('https://', `https://x-access-token:${token}@`);
      await Bun.$`git clone ${authed} ${directory}`.quiet();
    },
    async createBranch(directory, branch) {
      await Bun.$`git -C ${directory} checkout -B ${branch}`.quiet();
    },
    async checkoutBranch(directory, branch) {
      await Bun.$`git -C ${directory} fetch origin ${branch}`.quiet();
      await Bun.$`git -C ${directory} checkout ${branch}`.quiet();
    },
    async checkoutCommit(directory, commitSha) {
      await Bun.$`git -C ${directory} checkout ${commitSha}`.quiet();
    },
    async commitAll(directory, message) {
      await Bun.$`git -C ${directory} add -A`.quiet();
      await Bun.$`git -C ${directory} -c user.name=yaaabk -c user.email=agent@yaaabk.io commit -m ${message}`.quiet();
    },
    async push(directory, branch, options) {
      const flags = options?.force === true ? ['--force-with-lease'] : [];
      await Bun.$`git -C ${directory} push -u origin ${branch} ${flags}`.quiet();
    },
    async diff(directory) {
      // Three-dot diff: what the pull request branch changed relative to the
      // branch it forked from, which is what a reviewer needs to see.
      const result = await Bun.$`git -C ${directory} diff origin/HEAD...HEAD`.quiet();
      return result.stdout.toString();
    },
  };
}

/** The real `kubectl` + `wget` adapter for the deploy run. */
export function createKubectl(): Kubectl {
  return {
    async applyServerSide({ directory, namespace, path }) {
      const manifestPath = join(directory, path);
      await Bun.$`kubectl apply --server-side --namespace ${namespace} -f ${manifestPath}`.quiet();
    },
    async waitForRollout({ namespace, deploymentName, timeoutSeconds = 180 }) {
      await Bun.$`kubectl rollout status deployment/${deploymentName} --namespace ${namespace} --timeout=${`${timeoutSeconds}s`}`.quiet();
    },
    async checkHealth({ namespace, serviceName }) {
      const healthUrl = `http://${serviceName}.${namespace}.svc.cluster.local/health`;
      await Bun.$`wget -q -O - --timeout=5 ${healthUrl}`.quiet();
    },
    async labelDeployment({ namespace, deploymentName, labelKey, labelValue }) {
      await Bun.$`kubectl label deployment ${deploymentName} --namespace ${namespace} ${`${labelKey}=${labelValue}`} --overwrite`.quiet();
    },
    async undoRollout({ namespace, deploymentName }) {
      const history =
        await Bun.$`kubectl rollout history deployment/${deploymentName} --namespace ${namespace}`
          .quiet()
          .nothrow();
      if (history.exitCode !== 0) {
        return { rolledBack: false, error: history.stderr.toString().trim() };
      }
      const revisions = history.stdout
        .toString()
        .split('\n')
        .filter((line) => /^\s*\d+\s+/.test(line)).length;
      if (revisions < 2) return { rolledBack: false };
      const undone =
        await Bun.$`kubectl rollout undo deployment/${deploymentName} --namespace ${namespace}`
          .quiet()
          .nothrow();
      if (undone.exitCode !== 0) {
        return { rolledBack: false, error: undone.stderr.toString().trim() };
      }
      await Bun.$`kubectl rollout status deployment/${deploymentName} --namespace ${namespace} --timeout=120s`.quiet();
      return { rolledBack: true };
    },
    async podLogs({ namespace, deploymentName }) {
      // Tail keeps a broken deploy's report bounded while still capturing the
      // logs that explain why the new pods never became ready.
      const result =
        await Bun.$`kubectl logs deployment/${deploymentName} --namespace ${namespace} --all-containers --prefix --tail=200`
          .quiet()
          .nothrow();
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      return [stdout, stderr].filter((part) => part.trim() !== '').join('\n');
    },
  };
}

/** One OpenCode invocation, expressed as the command and its arguments. */
export interface OpenCodeRunRequest {
  directory: string;
  args: string[];
}

/** The result of running OpenCode once. */
export interface OpenCodeRunResult {
  exitCode: number;
  stdout: string;
  /** Diagnostics and provider errors, which OpenCode writes to stderr. */
  stderr?: string;
}

/**
 * Runs one OpenCode command. Injectable so the invocation can be asserted
 * without spawning the real CLI.
 */
export type OpenCodeRunner = (request: OpenCodeRunRequest) => Promise<OpenCodeRunResult>;

/** Reads the verdict a review run wrote for its pull request. */
export type OpenCodeVerdictReader = (directory: string) => Promise<ReviewVerdict>;

export interface OpenCodeAdapterOptions {
  run?: OpenCodeRunner;
  readVerdict?: OpenCodeVerdictReader;
  /**
   * Delays between retries when OpenCode cannot resolve the model yet.
   * Defaults to {@link MODEL_RETRY_DELAYS_MS}; tests pass `[]` to keep runs fast.
   */
  retryDelaysMs?: number[];
}

/**
 * How long to wait before re-running when OpenCode has not synced its provider
 * catalogue yet.
 *
 * On a cold container the first invocation resolves the model before the
 * background service has fetched the catalogue, so it fails with
 * `Model unavailable` even for a model OpenRouter does publish. The service it
 * starts stays up and finishes syncing, so a retry seconds later succeeds.
 */
export const MODEL_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 15_000, 15_000];

/**
 * The non-interactive OpenCode arguments every Agent run uses.
 *
 * `--model` is explicit because the runtime has no default model, and `--auto`
 * approves routine permission prompts so a Job cannot hang waiting for a human
 * who is not attached to it.
 *
 * Deliberately no `--standalone`: a private server does not wait for the
 * catalogue either, and it dies with the failed invocation, so retrying never
 * becomes possible. The shared background service does persist and finishes
 * syncing, which is what makes {@link MODEL_RETRY_DELAYS_MS} work.
 */
export function openCodeRunArgs(model: string, prompt: string): string[] {
  return ['run', '--model', model, '--auto', prompt];
}

/** Largest output tail kept for the final report, so a chatty run cannot grow without bound. */
export const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

/**
 * Keeps the last `limit` bytes written to it.
 *
 * The Job streams OpenCode's whole session to its own stdout so the UI can
 * follow along, but only the tail is worth reporting back: keeping everything
 * in memory is what let a six-minute run grow until the kubelet killed it.
 */
export class BoundedOutput {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly limit: number = MAX_CAPTURED_OUTPUT_BYTES) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    let excess = this.size - this.limit;
    while (excess > 0) {
      const first = this.chunks[0];
      if (first === undefined) break;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
        excess -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
        excess = 0;
      }
    }
  }

  text(): string {
    const merged = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
}

/** Copies one stream to `write` as it arrives, keeping a bounded tail. */
async function pump(
  source: ReadableStream<Uint8Array> | undefined,
  write: (chunk: Uint8Array) => void,
  captured: BoundedOutput,
): Promise<void> {
  if (source === undefined) return;
  const reader = source.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    write(value);
    captured.append(value);
  }
}

/**
 * Runs OpenCode through Bun's process API, streaming its output live.
 *
 * The Job's own stdout is what `kubectl logs` and the YAAABK UI read, so the
 * child's output is forwarded as it arrives rather than echoed on exit — a
 * long, healthy run must not look identical to a hung one. The returned tail
 * is what gets reported back when the run ends.
 */
const runWithBun: OpenCodeRunner = async ({ directory, args }) => {
  const child = Bun.spawn(['opencode', ...args], {
    cwd: directory,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new BoundedOutput();
  const stderr = new BoundedOutput();
  await Promise.all([
    pump(child.stdout, (chunk) => process.stdout.write(chunk), stdout),
    pump(child.stderr, (chunk) => process.stderr.write(chunk), stderr),
    child.exited,
  ]);
  return {
    exitCode: child.exitCode ?? 1,
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
};

/** Reads and validates the verdict the review skill writes to the workspace. */
async function readVerdictFile(directory: string): Promise<ReviewVerdict> {
  const verdictFile = Bun.file(join(directory, REVIEW_VERDICT_PATH));
  if (!(await verdictFile.exists())) {
    throw new Error(`The review agent did not write ${REVIEW_VERDICT_PATH}`);
  }
  const raw = (await verdictFile.json()) as { event?: unknown; body?: unknown };
  if (
    (raw.event !== 'approve' && raw.event !== 'request-changes') ||
    typeof raw.body !== 'string' ||
    raw.body.trim() === ''
  ) {
    throw new Error(
      `${REVIEW_VERDICT_PATH} must contain {"event": "approve" | "request-changes", "body": "…"}`,
    );
  }
  return { event: raw.event, body: raw.body };
}

/**
 * The real OpenCode adapter, running the implement-issue and review-pr skills.
 *
 * Every invocation names the configured model and runs non-interactively: the
 * Job has no TTY, so a permission prompt would otherwise wait forever.
 */
export function createOpenCode(
  config: { model?: string },
  options: OpenCodeAdapterOptions = {},
): OpenCode {
  const run = options.run ?? runWithBun;
  const readVerdict = options.readVerdict ?? readVerdictFile;
  const retryDelays = options.retryDelaysMs ?? MODEL_RETRY_DELAYS_MS;

  /** The model to invoke, failing with the configuration to set when absent. */
  function requireModel(): string {
    const model = config.model?.trim();
    if (model === undefined || model === '') {
      throw new Error('Set AGENT_MODEL to the OpenCode model in provider/model form');
    }
    return model;
  }

  /**
   * Whether OpenCode gave up before doing any work because its provider
   * catalogue had not finished loading. Retrying such a run is safe: the error
   * is raised while the session is loading, before a tool call or an edit.
   */
  function isModelUnavailable(result: OpenCodeRunResult): boolean {
    if (result.exitCode === 0) return false;
    return `${result.stdout}\n${result.stderr ?? ''}`.includes('Model unavailable');
  }

  /** Runs OpenCode with `prompt`, retrying until the model catalogue is ready. */
  async function invoke(directory: string, prompt: string) {
    const args = openCodeRunArgs(requireModel(), prompt);
    let result = await run({ directory, args });
    for (const delay of retryDelays) {
      if (!isModelUnavailable(result)) break;
      process.stdout.write(
        `[yaaabk] model catalogue not ready; retrying in ${Math.round(delay / 1000)}s\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      result = await run({ directory, args });
    }
    // Provider failures arrive on stderr; dropping it leaves an empty run log
    // with no clue why the attempt failed.
    const output = [result.stdout, result.stderr ?? ''].filter((part) => part.trim() !== '');
    return { exitCode: result.exitCode, output: output.join('\n') };
  }

  return {
    async implement({ directory, prompt }) {
      return invoke(directory, prompt);
    },

    async review({ directory, prompt }) {
      const result = await invoke(directory, prompt);
      const verdict = await readVerdict(directory);
      return {
        exitCode: result.exitCode,
        output: result.output,
        verdict,
      };
    },
  };
}

/** The real checks adapter: install, then the project's pre-commit hooks. */
export function createChecks(): Checks {
  const steps: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['install', ['--frozen-lockfile']],
    ['run', ['--if-present', 'lint']],
    ['run', ['--if-present', 'typecheck']],
    ['run', ['--if-present', 'test:unit']],
  ];
  return {
    async run(directory) {
      const output: string[] = [];
      for (const [script, args] of steps) {
        const result = await Bun.$`bun ${script} ${args}`.cwd(directory).nothrow().quiet();
        output.push(result.stdout.toString(), result.stderr.toString());
        if (result.exitCode !== 0) {
          return { passed: false, output: output.join('\n') };
        }
      }
      return { passed: true, output: output.join('\n') };
    },
  };
}

/** The real GitHub adapter: read the Issue, open the pull request. */
export function createGitHub(config: AgentConfig): GitHub {
  const { owner, repo } = parseRepoUrl(config.repoUrl);
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    authorization: `Bearer ${config.githubToken}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };

  return {
    async fetchIssue(issueNumber): Promise<AgentIssue> {
      const response = await fetch(`${base}/issues/${issueNumber}`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch issue #${issueNumber}: ${response.status}`);
      }
      const issue = (await response.json()) as {
        number: number;
        title: string;
        body: string | null;
      };
      return { number: issue.number, title: issue.title, body: issue.body ?? '' };
    },
    async openPullRequest({ branch, title, body, labels }): Promise<AgentPullRequest> {
      const response = await fetch(`${base}/pulls`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ head: branch, base: 'main', title, body }),
      });
      if (!response.ok) {
        throw new Error(`Failed to open pull request: ${response.status}`);
      }
      const pull = (await response.json()) as { number: number; html_url: string };
      if (labels.length > 0) {
        await fetch(`${base}/issues/${pull.number}/labels`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ labels }),
        });
      }
      return { number: pull.number, url: pull.html_url };
    },
    async createReview({ pullNumber, event, body }): Promise<void> {
      const response = await fetch(`${base}/pulls/${pullNumber}/reviews`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event: event === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
          body,
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to post review on #${pullNumber}: ${response.status}`);
      }
    },
  };
}

/** The real reporter: POST the outcome back to YAAABK. */
export function createReporter(
  config: AgentConfig,
  options: { fetch?: typeof fetch } = {},
): Reporter {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async report({ prUrl, logs, costCents, commitSha, deployOutcome }) {
      if (
        config.apiUrl === undefined ||
        config.runId === undefined ||
        config.runToken === undefined
      ) {
        return;
      }
      await doFetch(`${config.apiUrl}/api/agent-runs/${config.runId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: config.runToken,
          prUrl,
          logs,
          ...(costCents === undefined ? {} : { costCents }),
          ...(commitSha === undefined ? {} : { commitSha }),
          ...(deployOutcome === undefined ? {} : { deployOutcome }),
        }),
      });
    },
  };
}

/** OpenRouter's response shape for the current key's usage. */
interface KeyUsagePayload {
  data?: { usage?: number };
}

/**
 * The real spend meter: reads the run's OpenRouter key usage.
 *
 * `GET /api/v1/key` returns the authenticated key's total spend in USD, so the
 * agent diffs it across the model call to price the attempt. Any failure (no
 * key, network, malformed body) yields `undefined`, so metering never breaks a
 * run.
 */
export function createOpenRouterMeter(
  config: AgentConfig,
  options: { fetch?: typeof fetch } = {},
): SpendMeter {
  const base = (config.openrouterBaseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = {
    authorization: `Bearer ${config.openrouterApiKey}`,
    accept: 'application/json',
  };
  return {
    async usageUsd() {
      try {
        const response = await doFetch(`${base}/key`, { headers });
        if (!response.ok) return undefined;
        const body = (await response.json()) as KeyUsagePayload;
        const usage = body.data?.usage;
        return typeof usage === 'number' && Number.isFinite(usage) ? usage : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Assembles the real dependencies the Job runs with. */
export function createDependencies(config: AgentConfig): AgentDependencies {
  return {
    git: createGit(),
    kubectl: createKubectl(),
    openCode: createOpenCode(config),
    checks: createChecks(),
    github: createGitHub(config),
    reporter: createReporter(config),
    spend: createOpenRouterMeter(config),
  };
}
