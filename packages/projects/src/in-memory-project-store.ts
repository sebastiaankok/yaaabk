import type { Project, ProjectStore } from './types';

/** Thrown when a Project name is already taken; SQLite surfaces the same via UNIQUE. */
export class DuplicateProjectNameError extends Error {
  constructor(name: string) {
    super(`Project "${name}" already exists`);
    this.name = 'DuplicateProjectNameError';
  }
}

/** Newest first, both when created in the same instant (id breaks ties). */
function byNewestFirst(a: Project, b: Project): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/**
 * A dependency-free {@link ProjectStore} for tests and for other modules that
 * need the Projects Module without a database file.
 */
export function createInMemoryProjectStore(): ProjectStore {
  const projects = new Map<string, Project>();

  return {
    create(project) {
      for (const existing of projects.values()) {
        if (existing.name === project.name) {
          throw new DuplicateProjectNameError(project.name);
        }
      }
      projects.set(project.id, { ...project });
    },

    get(id) {
      const project = projects.get(id);
      return project === undefined ? undefined : { ...project };
    },

    getByName(name) {
      for (const project of projects.values()) {
        if (project.name === name) {
          return { ...project };
        }
      }
      return undefined;
    },

    list() {
      return [...projects.values()].map((project) => ({ ...project })).sort(byNewestFirst);
    },

    update(project) {
      projects.set(project.id, { ...project });
    },

    delete(id) {
      projects.delete(id);
    },
  };
}
