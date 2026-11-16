import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { K8sClient } from '@yaaabk/k8s';
import { isSkillLevel, projectNamespace } from '@yaaabk/shared';
import { isValidProjectName, type TemplateModule } from '@yaaabk/template';
import {
  ARGO_DESTINATION_SERVER,
  ARGO_SOURCE_PATH,
  ARGOCD_APP_PROJECT_NAME,
  ARGOCD_APPLICATION_NAMESPACE,
  DEFAULT_BRANCH,
  MAX_DESCRIPTION_LENGTH,
  PROJECT_NAME_LABEL,
} from './config';
import { consoleLogger, projectError, toProjectError, type ProjectsLogger } from './errors';
import { DuplicateProjectNameError } from './in-memory-project-store';
import type { RepositoryProvider } from './repository';
import type {
  CreateProjectOptions,
  NewProject,
  Project,
  ProjectPatch,
  ProjectStore,
  ProjectsModule,
  ProjectsResult,
  ProvisioningStep,
} from './types';

export type { ProjectsModule } from './types';

export interface ProjectsModuleOptions {
  store: ProjectStore;
  k8s: K8sClient;
  templates: TemplateModule;
  repositories: RepositoryProvider;
  /**
   * Credential the scaffold authenticates its HTTPS push with, e.g. a GitHub
   * token. A resolver is evaluated per `create`, so a credential entered in
   * Settings takes effect without a restart; a plain string is used as-is.
   * When omitted or empty the push is unauthenticated (local dev only).
   */
  githubToken?: string | (() => Promise<string | undefined>);
  /** Branch the scaffold pushes and ArgoCD tracks. Defaults to `main`. */
  branch?: string;
  /** ArgoCD destination server. Defaults to the in-cluster API server. */
  argoServer?: string;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable id generator. Defaults to `crypto.randomUUID`. */
  ids?: () => string;
  logger?: ProjectsLogger;
}

/** A query/command result shaped like the typed ports the module consumes. */
type PortResult = { ok: true } | { ok: false; error: { kind: string; message: string } };

/** Returns a human-readable reason the input is not a valid Project, if any. */
function invalidReason(input: NewProject): string | undefined {
  if (!isValidProjectName(input.name.trim())) {
    return `"${input.name}" is not a valid project name; use lowercase letters, digits and single hyphens, starting with a letter (max 39 characters)`;
  }
  const description = input.description.trim();
  if (description.length === 0) {
    return 'A project description is required';
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (!isSkillLevel(input.skillLevel)) {
    return `"${input.skillLevel}" is not a valid skill level`;
  }
  return undefined;
}

/** Builds the public Projects Module. */
export function createProjectsModule(options: ProjectsModuleOptions): ProjectsModule {
  const { store, k8s, templates, repositories } = options;
  const logger = options.logger ?? consoleLogger;
  const now = options.clock ?? (() => new Date());
  const newId = options.ids ?? randomUUID;
  const branch = options.branch ?? DEFAULT_BRANCH;
  const argoServer = options.argoServer ?? ARGO_DESTINATION_SERVER;

  /**
   * Runs an operation, mapping failures to typed errors and logging every
   * attempt for auditability.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<ProjectsResult<T>> {
    try {
      const value = await run();
      logger.info(`projects ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toProjectError(operation, error);
      logger.error(`projects ${operation} failed`, {
        ...fields,
        kind: mapped.kind,
        // The mapped kind alone hides the cause (e.g. a scaffold push failing
        // with git's "could not read Username"); keep the message.
        error: mapped.message,
      });
      return { ok: false, error: mapped };
    }
  }

  /** Unwraps a typed port result, treating `not-found` as already done. */
  async function requireOk(
    kind: 'kubernetes' | 'repository',
    operation: string,
    run: () => Promise<PortResult>,
  ): Promise<void> {
    const result = await run();
    if (result.ok) {
      return;
    }
    if (result.error.kind === 'not-found') {
      return;
    }
    throw projectError(kind, `${operation} failed: ${result.error.message}`);
  }

  /** Best-effort teardown of the resources a failed `create` left behind. */
  async function rollback(projectName: string, undo: Array<() => Promise<void>>): Promise<void> {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (error) {
        logger.error('projects rollback step failed', { name: projectName, error: String(error) });
      }
    }
  }

  /** Resolves the scaffold push credential, supporting a per-call resolver. */
  async function scaffoldToken(): Promise<string | undefined> {
    const configured = options.githubToken;
    const token = typeof configured === 'function' ? await configured() : configured;
    return token === undefined || token === '' ? undefined : token;
  }

  async function create(
    input: NewProject,
    createOptions: CreateProjectOptions = {},
  ): Promise<ProjectsResult<Project>> {
    const name = input.name.trim();
    return guard('create', { name }, async () => {
      const reason = invalidReason(input);
      if (reason !== undefined) {
        throw projectError('invalid-input', reason);
      }
      if (store.getByName(name) !== undefined) {
        throw projectError('duplicate-name', `A project named "${name}" already exists`);
      }

      const emit = (step: ProvisioningStep, status: 'started' | 'completed'): void =>
        createOptions.onProgress?.({ step, status });
      const step = async <T>(which: ProvisioningStep, run: () => Promise<T>): Promise<T> => {
        emit(which, 'started');
        const value = await run();
        emit(which, 'completed');
        return value;
      };

      const id = newId();
      const namespace = projectNamespace(id);
      const description = input.description.trim();
      const undo: Array<() => Promise<void>> = [];
      let workingDirectory: string | undefined;

      try {
        const repository = await step('repository', async () => {
          const result = await repositories.create({ name, description });
          if (!result.ok) {
            throw projectError('repository', result.error.message);
          }
          return result.value;
        });
        undo.push(() =>
          requireOk('repository', 'repository.delete', () =>
            repositories.delete(repository.fullName),
          ),
        );

        await step('scaffold', async () => {
          const token = await scaffoldToken();
          const result = await templates.scaffold({
            id,
            name,
            repoUrl: repository.cloneUrl,
            argoAppName: name,
            branch,
            // The scaffold pushes over the same HTTPS remote GitHub returned;
            // authenticate it with the configured credential (empty for SSH
            // remotes, where the agent's key takes over).
            ...(token === undefined ? {} : { token }),
          });
          if (!result.ok) {
            throw projectError('scaffold', result.error.message);
          }
          workingDirectory = result.value.directory;
        });

        await step('argocd', async () => {
          // The Application lands beside the backend, in `yaaabk`, and defers
          // to the shared, GitOps-managed AppProject. Its destination is the
          // Project namespace, which ArgoCD creates from the scaffold's
          // Namespace manifest — the Application resource and what it deploys
          // are deliberately in different namespaces.
          const result = await k8s.applications.create(ARGOCD_APPLICATION_NAMESPACE, name, {
            project: ARGOCD_APP_PROJECT_NAME,
            source: { repoURL: repository.url, path: ARGO_SOURCE_PATH, targetRevision: branch },
            destination: { server: argoServer, namespace },
            syncPolicy: { automated: { prune: true, selfHeal: true } },
            labels: { [PROJECT_NAME_LABEL]: name },
          });
          if (!result.ok) {
            throw projectError('kubernetes', result.error.message);
          }
          // Deleting the Application lets ArgoCD prune the scaffold — including
          // its Namespace manifest — so it is the single undo for cluster
          // state.
          undo.push(() =>
            requireOk('kubernetes', 'applications.delete', () =>
              k8s.applications.delete(ARGOCD_APPLICATION_NAMESPACE, name),
            ),
          );
        });

        const timestamp = now().toISOString();
        const project: Project = {
          id,
          name,
          description,
          skillLevel: input.skillLevel,
          repoUrl: repository.url,
          repoFullName: repository.fullName,
          namespace,
          argoAppName: name,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        await step('persist', async () => {
          try {
            store.create(project);
          } catch (error) {
            if (error instanceof DuplicateProjectNameError) {
              throw projectError('duplicate-name', error.message);
            }
            throw error;
          }
        });

        return project;
      } catch (error) {
        await rollback(name, undo);
        throw error;
      } finally {
        if (workingDirectory !== undefined) {
          await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
        }
      }
    });
  }

  return {
    create,

    list() {
      return guard('list', {}, async () => store.list());
    },

    get(id) {
      return guard('get', { id }, async () => {
        const project = store.get(id);
        if (project === undefined) {
          throw projectError('not-found', `No project with id "${id}"`);
        }
        return project;
      });
    },

    update(id, patch: ProjectPatch) {
      return guard('update', { id }, async () => {
        const project = store.get(id);
        if (project === undefined) {
          throw projectError('not-found', `No project with id "${id}"`);
        }

        let description = project.description;
        if (patch.description !== undefined) {
          description = patch.description.trim();
          if (description.length === 0) {
            throw projectError('invalid-input', 'A project description is required');
          }
          if (description.length > MAX_DESCRIPTION_LENGTH) {
            throw projectError(
              'invalid-input',
              `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
            );
          }
        }

        let skillLevel = project.skillLevel;
        if (patch.skillLevel !== undefined) {
          if (!isSkillLevel(patch.skillLevel)) {
            throw projectError('invalid-input', `"${patch.skillLevel}" is not a valid skill level`);
          }
          skillLevel = patch.skillLevel;
        }

        const updated: Project = {
          ...project,
          description,
          skillLevel,
          updatedAt: now().toISOString(),
        };
        store.update(updated);
        return updated;
      });
    },

    export(id, input) {
      return guard('export', { id, owner: input.owner }, async () => {
        const project = store.get(id);
        if (project === undefined) {
          throw projectError('not-found', `No project with id "${id}"`);
        }
        const owner = input.owner.trim();
        const repoName = (input.repoName ?? project.name).trim();
        if (!isValidProjectName(owner)) {
          throw projectError('invalid-input', `"${owner}" is not a valid GitHub username`);
        }
        if (!isValidProjectName(repoName)) {
          throw projectError('invalid-input', `"${repoName}" is not a valid repository name`);
        }

        // Grant the Developer access before the move so the repository never
        // sits between two owners they cannot see.
        const access = await repositories.addCollaborator(project.repoFullName, owner);
        if (!access.ok) {
          throw projectError('repository', access.error.message);
        }

        const transferred = await repositories.transfer(project.repoFullName, {
          newOwner: owner,
          repoName,
        });
        if (!transferred.ok) {
          throw projectError('repository', transferred.error.message);
        }
        const repository = transferred.value;

        const syncPolicy = { automated: { prune: true, selfHeal: true } } as const;
        const application = await k8s.applications.update(
          ARGOCD_APPLICATION_NAMESPACE,
          project.argoAppName,
          {
            project: ARGOCD_APP_PROJECT_NAME,
            source: { repoURL: repository.url, path: ARGO_SOURCE_PATH, targetRevision: branch },
            destination: { server: argoServer, namespace: project.namespace },
            syncPolicy,
            labels: { [PROJECT_NAME_LABEL]: project.name },
          },
        );
        if (!application.ok) {
          throw projectError('kubernetes', application.error.message);
        }

        const updated: Project = {
          ...project,
          repoFullName: repository.fullName,
          repoUrl: repository.url,
          updatedAt: now().toISOString(),
        };
        store.update(updated);
        return updated;
      });
    },

    remove(id) {
      return guard('remove', { id }, async () => {
        const project = store.get(id);
        if (project === undefined) {
          throw projectError('not-found', `No project with id "${id}"`);
        }

        // Deleting the Application lets ArgoCD prune the scaffold, which
        // includes the Project namespace manifest, so the namespace and its
        // contents cascade away. YAAABK deletes nothing else cluster-side.
        await requireOk('kubernetes', 'applications.delete', () =>
          k8s.applications.delete(ARGOCD_APPLICATION_NAMESPACE, project.argoAppName),
        );
        await requireOk('repository', 'repository.delete', () =>
          repositories.delete(project.repoFullName),
        );
        store.delete(id);
        return undefined;
      });
    },
  };
}
