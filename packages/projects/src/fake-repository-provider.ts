import type {
  CreateRepositoryInput,
  Repository,
  RepositoryErrorKind,
  RepositoryProvider,
  RepositoryResult,
} from './repository';

/** A recorded call to a {@link RepositoryProvider} method. */
export type RepositoryOperation =
  { op: 'create'; input: CreateRepositoryInput } | { op: 'delete'; fullName: string };

export interface FakeRepositoryProviderOptions {
  /** Owner the fake nests repositories under. Defaults to `acme`. */
  owner?: string;
  /** When set, every `create` fails with this message and kind. */
  createError?: { message: string; kind?: RepositoryErrorKind };
  /** When set, every `delete` fails with this message and kind. */
  deleteError?: { message: string; kind?: RepositoryErrorKind };
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
  };
}
