import type {
  CreateRepositoryInput,
  Repository,
  RepositoryErrorKind,
  RepositoryProvider,
  RepositoryResult,
} from './repository';

/** A recorded call to a {@link RepositoryProvider} method. */
export type RepositoryOperation =
  | { op: 'create'; input: CreateRepositoryInput }
  | { op: 'delete'; fullName: string }
  | { op: 'add-collaborator'; fullName: string; username: string }
  | { op: 'transfer'; fullName: string; newOwner: string; repoName?: string };

export interface FakeRepositoryProviderOptions {
  /** Owner the fake nests repositories under. Defaults to `acme`. */
  owner?: string;
  /** When set, every `create` fails with this message and kind. */
  createError?: { message: string; kind?: RepositoryErrorKind };
  /** When set, every `delete` fails with this message and kind. */
  deleteError?: { message: string; kind?: RepositoryErrorKind };
  /** When set, every `addCollaborator` fails with this message and kind. */
  addCollaboratorError?: { message: string; kind?: RepositoryErrorKind };
  /** When set, every `transfer` fails with this message and kind. */
  transferError?: { message: string; kind?: RepositoryErrorKind };
}

/** A {@link RepositoryProvider} that records its calls and touches no remote, for tests. */
export interface FakeRepositoryProvider extends RepositoryProvider {
  /** Every call made, in order. */
  readonly calls: RepositoryOperation[];
}

function fail(
  operation: string,
  message: string,
  kind: RepositoryErrorKind,
): RepositoryResult<never> {
  return { ok: false, error: { kind, operation, message } };
}

/**
 * Builds a Repository Provider for tests.
 *
 * `create` mints a deterministic repository under the configured owner;
 * configure `createError`/`deleteError` to exercise the failure paths.
 */
export function createFakeRepositoryProvider(
  options: FakeRepositoryProviderOptions = {},
): FakeRepositoryProvider {
  const owner = options.owner ?? 'acme';
  const calls: RepositoryOperation[] = [];

  return {
    calls,

    async create(input) {
      calls.push({ op: 'create', input });
      if (options.createError !== undefined) {
        return fail('create', options.createError.message, options.createError.kind ?? 'unknown');
      }
      const repository: Repository = {
        fullName: `${owner}/${input.name}`,
        cloneUrl: `https://github.com/${owner}/${input.name}.git`,
        url: `https://github.com/${owner}/${input.name}`,
      };
      return { ok: true, value: repository };
    },

    async delete(fullName) {
      calls.push({ op: 'delete', fullName });
      if (options.deleteError !== undefined) {
        return fail('delete', options.deleteError.message, options.deleteError.kind ?? 'unknown');
      }
      return { ok: true, value: undefined };
    },

    async addCollaborator(fullName, username) {
      calls.push({ op: 'add-collaborator', fullName, username });
      if (options.addCollaboratorError !== undefined) {
        return fail(
          'addCollaborator',
          options.addCollaboratorError.message,
          options.addCollaboratorError.kind ?? 'unknown',
        );
      }
      return { ok: true, value: undefined };
    },

    async transfer(fullName, target) {
      calls.push({
        op: 'transfer',
        fullName,
        newOwner: target.newOwner,
        repoName: target.repoName,
      });
      if (options.transferError !== undefined) {
        return fail(
          'transfer',
          options.transferError.message,
          options.transferError.kind ?? 'unknown',
        );
      }
      const name = target.repoName ?? fullName.split('/')[1];
      const repository: Repository = {
        fullName: `${target.newOwner}/${name}`,
        cloneUrl: `https://github.com/${target.newOwner}/${name}.git`,
        url: `https://github.com/${target.newOwner}/${name}`,
      };
      return { ok: true, value: repository };
    },
  };
}
