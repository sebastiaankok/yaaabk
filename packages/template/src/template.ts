import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectNamespace } from '@yaaabk/shared';
import {
  DEFAULT_AUTHOR,
  DEFAULT_PORT,
  defaultTemplateSource,
  isValidProjectName,
  isValidRepoUrl,
} from './config';
import { consoleLogger, templateError, toTemplateError, type TemplateLogger } from './errors';
import { createGitBackend } from './git';
import type { GitAuthor, GitBackend, TemplateSource } from './git-backend';
import { renderDirectory, type TemplateValues } from './interpolate';
import type { ScaffoldResult, TemplateModule, TemplateProject, TemplateResult } from './types';

export interface TemplateModuleOptions {
  /**
   * Low-level port the module is built on. Tests inject
   * {@link createFakeGitBackend}; when omitted the module shells out to `git`.
   */
  git?: GitBackend;
  /** Template to scaffold. Defaults to the in-repo `templates/svelte-bun`. */
  source?: TemplateSource;
  /** Directory the working copy is created under. Defaults to the OS temp dir. */
  workDir?: string;
  /** Author recorded on the scaffold commit. */
  author?: GitAuthor;
  /** Log intended operations and skip every repository mutation. */
  dryRun?: boolean;
  logger?: TemplateLogger;
}

/** The values every template file can interpolate. */
export function templateValues(project: TemplateProject): TemplateValues {
  return {
    projectId: project.id,
    projectName: project.name,
    namespace: projectNamespace(project.id),
    repoUrl: project.repoUrl,
    port: String(project.port ?? DEFAULT_PORT),
    argoAppName: project.argoAppName ?? project.name,
  };
}

/** Returns a human-readable reason the project cannot be scaffolded, if any. */
function invalidProjectReason(project: TemplateProject): string | undefined {
  if (!isValidProjectName(project.name)) {
    return `"${project.name}" is not a valid project name; use lowercase letters, digits and single hyphens, starting with a letter (max 39 characters)`;
  }
  if (!isValidRepoUrl(project.repoUrl)) {
    return `"${project.repoUrl}" is not a valid git repository URL`;
  }
  return undefined;
}

/** Builds the public Template Module. */
export function createTemplateModule(options: TemplateModuleOptions = {}): TemplateModule {
  const logger = options.logger ?? consoleLogger;
  const dryRun = options.dryRun ?? false;
  const source = options.source ?? defaultTemplateSource();
  const author = options.author ?? DEFAULT_AUTHOR;
  const workDir = options.workDir ?? tmpdir();
  let git = options.git;

  function gitBackend(): GitBackend {
    if (git === undefined) {
      git = createGitBackend();
    }
    return git;
  }

  /**
   * Runs a scaffold step, mapping failures to typed errors and logging every
   * attempt. In dry-run mode the template is still materialised (a read-only
   * clone or copy) but no repository is created and nothing is pushed.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<TemplateResult<T>> {
    try {
      const value = await run();
      logger.info(`template ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toTemplateError(operation, error);
      logger.error(`template ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  return {
    scaffold(project) {
      const branch = project.branch ?? 'main';
      const fields = { name: project.name, repoUrl: project.repoUrl, branch };

      return guard('scaffold', fields, async () => {
        const reason = invalidProjectReason(project);
        if (reason !== undefined) {
          throw templateError('invalid-project', reason);
        }

        const directory = await mkdtemp(join(workDir, `${project.name}-`));
        const backend = gitBackend();

        await backend.fetchTemplate(source, directory);
        const files = await renderDirectory(directory, templateValues(project));

        const result: ScaffoldResult = {
          name: project.name,
          repoUrl: project.repoUrl,
          branch,
          directory,
          files,
        };

        if (dryRun) {
          return result;
        }

        await backend.initRepository(directory);
        await backend.commitAll(directory, {
          message: `chore: scaffold ${project.name} from the YAAABK template`,
          author,
        });
        await backend.push(directory, { url: project.repoUrl, branch });

        return result;
      });
    },
  };
}
