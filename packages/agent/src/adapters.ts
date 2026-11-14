/// <reference types="bun" />
import type { AgentConfig } from './config';
import type {
  AgentDependencies,
  AgentIssue,
  AgentPullRequest,
  Checks,
  Git,
  GitHub,
  OpenCode,
  Reporter,
} from './ports';

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
    async commitAll(directory, message) {
      await Bun.$`git -C ${directory} add -A`.quiet();
      await Bun.$`git -C ${directory} -c user.name=yaaabk -c user.email=agent@yaaabk.io commit -m ${message}`.quiet();
    },
    async push(directory, branch) {
      await Bun.$`git -C ${directory} push -u origin ${branch}`.quiet();
    },
  };
}

/** The real OpenCode adapter, running the implement-issue skill. */
export function createOpenCode(): OpenCode {
  return {
    async implement({ directory, prompt }) {
      const result = await Bun.$`opencode run ${prompt}`.cwd(directory).nothrow().quiet();
      return { exitCode: result.exitCode, output: result.stdout.toString() };
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
  };
}

/** The real reporter: POST the outcome back to YAAABK. */
export function createReporter(config: AgentConfig): Reporter {
  return {
    async report({ prUrl, logs }) {
      if (
        config.apiUrl === undefined ||
        config.runId === undefined ||
        config.runToken === undefined
      ) {
        return;
      }
      await fetch(`${config.apiUrl}/api/agent-runs/${config.runId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: config.runToken, prUrl, logs }),
      });
    },
  };
}

/** Assembles the real dependencies the Job runs with. */
export function createDependencies(config: AgentConfig): AgentDependencies {
  return {
    git: createGit(),
    openCode: createOpenCode(),
    checks: createChecks(),
    github: createGitHub(config),
    reporter: createReporter(config),
  };
}
