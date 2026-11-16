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
  };
}

/** The real OpenCode adapter, running the implement-issue skill. */
export function createOpenCode(): OpenCode {
  /** Runs OpenCode with `prompt` and returns its exit code and output. */
  async function run(directory: string, prompt: string) {
    const result = await Bun.$`opencode run ${prompt}`.cwd(directory).nothrow().quiet();
    return { exitCode: result.exitCode, output: result.stdout.toString() };
  }

  return {
    async implement({ directory, prompt }) {
      return run(directory, prompt);
    },

    async review({ directory, prompt }) {
      const result = await run(directory, prompt);
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
      return {
        exitCode: result.exitCode,
        output: result.output,
        verdict: { event: raw.event, body: raw.body },
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
    async report({ prUrl, logs, costCents, commitSha }) {
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
    openCode: createOpenCode(),
    checks: createChecks(),
    github: createGitHub(config),
    reporter: createReporter(config),
    spend: createOpenRouterMeter(config),
  };
}
