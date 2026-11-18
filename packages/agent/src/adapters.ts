/// <reference types="bun" />
import { withReviewVerdict } from '@yaaabk/shared';
import { readFile } from 'node:fs/promises';
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
  Registry,
  Reporter,
  ReviewVerdict,
  SpendMeter,
} from './ports';
import { REVIEW_VERDICT_PATH } from './prompt';

/** Splits an HTTPS or SCP-like git remote into its owner and repository. */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const scpLike = cleaned.match(/^[^@]+@[^:]+:(.+)$/);
  const path = (scpLike?.[1] ?? cleaned)
    .split('/')
    .filter((part) => part !== '')
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
      // The implement-issue skill tells the Agent to leave its work committed,
      // so the tree is often already clean. Committing nothing exits non-zero
      // and fails an attempt whose checks passed, so skip the commit then.
      const changes = await Bun.$`git -C ${directory} status --porcelain`.quiet();
      if (changes.stdout.toString().trim() === '') return;
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

/** What a finished shell command exposes, regardless of how it was spawned. */
interface ShellResult {
  exitCode: number;
  stdout: { toString(): string };
  stderr: { toString(): string };
}

/**
 * Rejects with the command's own output when it failed.
 *
 * Bun's shell error only says "Failed with exit code 1"; kubectl writes the
 * reason — a rejected manifest, a missing permission — to stderr, and that is
 * what tells a Developer why a deploy stopped.
 */
async function expectSuccess(what: string, command: PromiseLike<ShellResult>): Promise<void> {
  const result = await command;
  if (result.exitCode === 0) return;
  const stderr = result.stderr.toString().trim();
  const stdout = result.stdout.toString().trim();
  throw new Error(`${what} failed: ${stderr === '' ? stdout : stderr}`);
}

/** The real `kubectl` + `wget` adapter for the deploy run. */
export function createKubectl(): Kubectl {
  return {
    async applyServerSide({ directory, namespace, path }) {
      const manifestPath = join(directory, path);
      await expectSuccess(
        'kubectl apply',
        Bun.$`kubectl apply --server-side --namespace ${namespace} -f ${manifestPath}`
          .quiet()
          .nothrow(),
      );
    },
    async setImage({ namespace, deploymentName, containerName, image }) {
      await expectSuccess(
        'kubectl set image',
        Bun.$`kubectl set image deployment/${deploymentName} ${`${containerName}=${image}`} --namespace ${namespace}`
          .quiet()
          .nothrow(),
      );
    },
    async waitForRollout({ namespace, deploymentName, timeoutSeconds = 180 }) {
      await expectSuccess(
        'kubectl rollout status',
        Bun.$`kubectl rollout status deployment/${deploymentName} --namespace ${namespace} --timeout=${`${timeoutSeconds}s`}`
          .quiet()
          .nothrow(),
      );
    },
    async checkHealth({ namespace, serviceName }) {
      const healthUrl = `http://${serviceName}.${namespace}.svc.cluster.local/health`;
      await expectSuccess(
        'the health check',
        Bun.$`wget -q -O - --timeout=5 ${healthUrl}`.quiet().nothrow(),
      );
    },
    async labelDeployment({ namespace, deploymentName, labelKey, labelValue }) {
      await expectSuccess(
        'kubectl label',
        Bun.$`kubectl label deployment ${deploymentName} --namespace ${namespace} ${`${labelKey}=${labelValue}`} --overwrite`
          .quiet()
          .nothrow(),
      );
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

/** One `bun <script> <args>` command the project checks run. */
export interface ChecksCommand {
  script: string;
  args: readonly string[];
}

/** Runs one command, injectable so the checks can be tested without Bun. */
export type ChecksRunner = (
  directory: string,
  script: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface ChecksOptions {
  run?: ChecksRunner;
  /** Clock used for the timing lines. Defaults to `Date.now`. */
  now?: () => number;
}

const defaultChecksRunner: ChecksRunner = async (directory, script, args) => {
  const result = await Bun.$`bun ${script} ${args}`.cwd(directory).nothrow().quiet();
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

/** Reads the scripts a project declares, or an empty record. */
async function projectScripts(directory: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      scripts?: unknown;
    };
    if (parsed.scripts === null || typeof parsed.scripts !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.scripts as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The commands a project's checks run.
 *
 * A project that declares `check` owns the definition of its checks; the
 * template defines one so lint, typecheck and tests cannot drift apart. Older
 * projects fall back to the individual scripts, including `test:unit` when
 * that is the only test script they expose.
 */
export function checksForScripts(scripts: Record<string, string>): ChecksCommand[] {
  if (scripts['check'] !== undefined) return [{ script: 'run', args: ['check'] }];

  const commands: ChecksCommand[] = [];
  if (scripts['lint'] !== undefined) commands.push({ script: 'run', args: ['lint'] });
  if (scripts['typecheck'] !== undefined) commands.push({ script: 'run', args: ['typecheck'] });
  if (scripts['test'] !== undefined) commands.push({ script: 'run', args: ['test'] });
  else if (scripts['test:unit'] !== undefined) {
    commands.push({ script: 'run', args: ['test:unit'] });
  }
  return commands;
}

/** Whether a failed install is the frozen lockfile being out of date. */
function isLockfileFailure(output: string): boolean {
  return /frozen|lockfile/i.test(output);
}

/** The real checks adapter: install, then the project's own checks. */
export function createChecks(options: ChecksOptions = {}): Checks {
  const run = options.run ?? defaultChecksRunner;
  const now = options.now ?? Date.now;

  return {
    async run(directory) {
      const output: string[] = [];
      const installStarted = now();
      let install = await run(directory, 'install', ['--frozen-lockfile', '--prefer-offline']);
      output.push(
        `[yaaabk] bun install --frozen-lockfile (${((now() - installStarted) / 1000).toFixed(1)}s)`,
        install.stdout,
        install.stderr,
      );

      if (install.exitCode !== 0 && isLockfileFailure(`${install.stdout}\n${install.stderr}`)) {
        // The template ships a lockfile, but an agent adding a dependency (or
        // an older project without one) still has to be able to run its
        // checks. Updating the lockfile here is committed with the change.
        output.push('[yaaabk] lockfile is missing or stale; installing without --frozen-lockfile');
        const retryStarted = now();
        install = await run(directory, 'install', ['--prefer-offline']);
        output.push(
          `[yaaabk] bun install (${((now() - retryStarted) / 1000).toFixed(1)}s)`,
          install.stdout,
          install.stderr,
        );
      }
      if (install.exitCode !== 0) return { passed: false, output: output.join('\n') };

      const commands = checksForScripts(await projectScripts(directory));
      for (const command of commands) {
        const started = now();
        const result = await run(directory, command.script, command.args);
        const seconds = ((now() - started) / 1000).toFixed(1);
        output.push(
          `[yaaabk] bun ${command.script} ${command.args.join(' ')} (${seconds}s)`,
          result.stdout,
          result.stderr,
        );
        if (result.exitCode !== 0) return { passed: false, output: output.join('\n') };
      }
      return { passed: true, output: output.join('\n') };
    },
  };
}

/** The real GitHub adapter: read the Issue, open the pull request. */
export function createGitHub(config: AgentConfig, options: { fetch?: typeof fetch } = {}): GitHub {
  const doFetch = options.fetch ?? globalThis.fetch;
  const { owner, repo } = parseRepoUrl(config.repoUrl);
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    authorization: `Bearer ${config.githubToken}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };

  /** The open pull request whose head is `branch`, when the API lists one. */
  async function findOpenPullRequest(
    branch: string,
  ): Promise<{ number: number; html_url: string } | undefined> {
    const listed = await doFetch(
      `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      { headers },
    );
    if (!listed.ok) return undefined;
    const pulls = (await listed.json()) as Array<{ number: number; html_url: string }>;
    return pulls[0];
  }

  return {
    async fetchIssue(issueNumber): Promise<AgentIssue> {
      const response = await doFetch(`${base}/issues/${issueNumber}`, { headers });
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
      const response = await doFetch(`${base}/pulls`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ head: branch, base: 'main', title, body }),
      });

      let pull: { number: number; html_url: string };
      if (response.ok) {
        pull = (await response.json()) as { number: number; html_url: string };
      } else if (response.status === 422) {
        // A fix run updates the branch of an existing pull request; opening it
        // again is refused ("A pull request already exists"). Reuse that one
        // instead of failing an attempt whose checks already passed.
        const existing = await findOpenPullRequest(branch);
        if (existing === undefined) {
          throw new Error(`Failed to open pull request: ${response.status}`);
        }
        pull = existing;
      } else {
        throw new Error(`Failed to open pull request: ${response.status}`);
      }

      if (labels.length > 0) {
        await doFetch(`${base}/issues/${pull.number}/labels`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ labels }),
        });
      }
      return { number: pull.number, url: pull.html_url };
    },
    async createReview({ pullNumber, event, body }): Promise<void> {
      const post = (reviewEvent: string, reviewBody: string) =>
        doFetch(`${base}/pulls/${pullNumber}/reviews`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ event: reviewEvent, body: reviewBody }),
        });

      const response = await post(event === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES', body);
      if (response.ok) return;
      if (response.status !== 422) {
        throw new Error(`Failed to post review on #${pullNumber}: ${response.status}`);
      }

      // The Agent's token authored the pull request, and GitHub refuses an
      // approval or change request from the author ("Can not approve your own
      // pull request"). A comment review is allowed, so carry the verdict in a
      // marker the CI tracker reads instead.
      const fallback = await post('COMMENT', withReviewVerdict(event, body));
      if (!fallback.ok) {
        throw new Error(`Failed to post review on #${pullNumber}: ${fallback.status}`);
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
    async report({ prUrl, logs, costCents, reviewVerdict, reviewBody, commitSha, deployOutcome }) {
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
          ...(reviewVerdict === undefined ? {} : { reviewVerdict }),
          ...(reviewBody === undefined ? {} : { reviewBody }),
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

/** Manifest media types a registry may serve for a tagged image. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The registry, repository and tag of a container image reference. */
export function parseImage(image: string): { registry: string; repository: string; tag: string } {
  const slash = image.indexOf('/');
  if (slash === -1) throw new Error(`Cannot parse image reference: ${image}`);
  const registry = image.slice(0, slash);
  const rest = image.slice(slash + 1);
  const at = rest.indexOf('@');
  if (at !== -1) {
    return { registry, repository: rest.slice(0, at), tag: rest.slice(at + 1) };
  }
  const colon = rest.lastIndexOf(':');
  if (colon === -1) return { registry, repository: rest, tag: 'latest' };
  return { registry, repository: rest.slice(0, colon), tag: rest.slice(colon + 1) };
}

export interface RegistryOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

/**
 * Waits for a tag to appear in the registry.
 *
 * The token request is best-effort: public GHCR packages serve manifests
 * anonymously, while a private package simply keeps returning an auth error
 * until the deploy times out with a message naming the image.
 */
export function createRegistry(options: RegistryOptions = {}): Registry {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 5_000;

  async function pullToken(registry: string, repository: string): Promise<string | undefined> {
    const endpoint = `https://${registry}/token?service=${encodeURIComponent(registry)}&scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
    const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined,
    );
    if (response?.ok !== true) return undefined;
    const body = (await response.json().catch(() => undefined)) as
      { token?: unknown; access_token?: unknown } | undefined;
    if (typeof body?.token === 'string') return body.token;
    if (typeof body?.access_token === 'string') return body.access_token;
    return undefined;
  }

  return {
    async waitForImage({ image, timeoutMs = 5 * 60_000 }) {
      const { registry, repository, tag } = parseImage(image);
      const deadline = Date.now() + timeoutMs;
      let lastStatus: number | undefined;

      for (;;) {
        const token = await pullToken(registry, repository);
        const response = await fetchImpl(`https://${registry}/v2/${repository}/manifests/${tag}`, {
          method: 'HEAD',
          headers: {
            accept: MANIFEST_ACCEPT,
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);

        if (response?.ok === true) return;
        lastStatus = response?.status;

        if (Date.now() >= deadline) {
          throw new Error(
            `Image ${image} was not published within ${Math.round(timeoutMs / 1000)}s${lastStatus === undefined ? '' : ` (last status ${lastStatus})`}`,
          );
        }
        await sleep(pollMs);
      }
    },
  };
}

/** Assembles the real dependencies the Job runs with. */
export function createDependencies(config: AgentConfig): AgentDependencies {
  return {
    git: createGit(),
    kubectl: createKubectl(),
    registry: createRegistry(),
    openCode: createOpenCode(config),
    checks: createChecks(),
    github: createGitHub(config),
    reporter: createReporter(config),
    spend: createOpenRouterMeter(config),
  };
}
