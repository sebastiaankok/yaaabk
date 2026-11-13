import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { K8sClient } from '@yaaabk/k8s';
import { isSkillLevel, projectNamespace } from '@yaaabk/shared';
import { isValidProjectName, type TemplateModule } from '@yaaabk/template';
import {
  ARGO_DESTINATION_SERVER,
  ARGO_SOURCE_PATH,
  DEFAULT_BRANCH,
  GITHUB_TOKEN_KEY,
  MAX_DESCRIPTION_LENGTH,
  PROJECT_AGENT_ROLE_BINDING,
  PROJECT_AGENT_ROLE_REF,
  PROJECT_AGENT_SERVICE_ACCOUNT,
  PROJECT_GITHUB_SECRET,
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
   * GitHub token copied into each new namespace so the agent can reach the
   * repository. When omitted the Secret step is skipped (e.g. local dev).
   */
  githubToken?: string;
  /** Branch the scaffold pushes and ArgoCD tracks. Defaults to `main`. */
  branch?: string;
  /** ArgoCD project to scope the Application to. Defaults to `default`. */
  argoProject?: string;
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
  const argoProject = options.argoProject ?? 'default';
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
      logger.error(`projects ${operation} failed`, { ...fields, kind: mapped.kind });
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
          const result = await templates.scaffold({
            id,
            name,
            repoUrl: repository.cloneUrl,
            argoAppName: name,
            branch,
          });
          if (!result.ok) {
            throw projectError('scaffold', result.error.message);
          }
          workingDirectory = result.value.directory;
        });

        await step('namespace', async () => {
          const result = await k8s.namespaces.create(namespace, {
            labels: { [PROJECT_NAME_LABEL]: name },
          });
          if (!result.ok) {
            throw projectError('kubernetes', result.error.message);
          }
          // Deleting the namespace cascades to its ServiceAccount, RoleBinding,
          // Secret and Application, so it is the single undo for cluster state.
          undo.push(() =>
            requireOk('kubernetes', 'namespaces.delete', () => k8s.namespaces.delete(namespace)),
          );
        });

        await step('service-account', async () => {
          const result = await k8s.serviceAccounts.create(namespace, PROJECT_AGENT_SERVICE_ACCOUNT);
          if (!result.ok) {
            throw projectError('kubernetes', result.error.message);
          }
        });

        await step('role-binding', async () => {
          const result = await k8s.roleBindings.create(namespace, PROJECT_AGENT_ROLE_BINDING, {
            roleRef: PROJECT_AGENT_ROLE_REF,
            subjects: [{ kind: 'ServiceAccount', name: PROJECT_AGENT_SERVICE_ACCOUNT, namespace }],
          });
          if (!result.ok) {
            throw projectError('kubernetes', result.error.message);
          }
        });

        if (options.githubToken !== undefined) {
          const token = options.githubToken;
          await step('secret', async () => {
            const result = await k8s.secrets.create(namespace, PROJECT_GITHUB_SECRET, {
              [GITHUB_TOKEN_KEY]: token,
            });
            if (!result.ok) {
              throw projectError('kubernetes', result.error.message);
            }
          });
        }

        await step('argocd', async () => {
          const result = await k8s.applications.create(namespace, name, {
            project: argoProject,
            source: { repoURL: repository.url, path: ARGO_SOURCE_PATH, targetRevision: branch },
            destination: { server: argoServer, namespace },
            syncPolicy: { automated: { prune: true, selfHeal: true } },
            labels: { [PROJECT_NAME_LABEL]: name },
          });
          if (!result.ok) {
            throw projectError('kubernetes', result.error.message);
          }
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

    remove(id) {
      return guard('remove', { id }, async () => {
        const project = store.get(id);
        if (project === undefined) {
          throw projectError('not-found', `No project with id "${id}"`);
        }

        await requireOk('kubernetes', 'applications.delete', () =>
          k8s.applications.delete(project.namespace, project.argoAppName),
        );
        await requireOk('kubernetes', 'namespaces.delete', () =>
          k8s.namespaces.delete(project.namespace),
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
