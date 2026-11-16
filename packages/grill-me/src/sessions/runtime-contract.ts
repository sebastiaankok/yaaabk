/**
 * The shared SessionRuntime contract.
 *
 * Every adapter runs these cases, so the local and Kubernetes runtimes cannot
 * drift on readiness, inspection, listing or stop semantics. The helper imports
 * no test framework: adapter tests wrap each case in their runner of choice.
 */

import assert from 'node:assert/strict';
import type { SessionRuntime, SessionRuntimeRef, SessionRuntimeSpec } from './runtime-types';

export interface SessionRuntimeContractHarness {
  runtime: SessionRuntime;
  /** A valid spec, with optional overrides. */
  spec(overrides?: Partial<SessionRuntimeSpec>): SessionRuntimeSpec;
  /** Makes the next `start` fail with a runtime that reports `reason`. */
  failNextStart(reason: string): void;
}

export interface SessionRuntimeContractCase {
  name: string;
  run(): Promise<void>;
}

let sequence = 0;

/** Builds the shared cases for one adapter. */
export function sessionRuntimeContract(
  createHarness: () => SessionRuntimeContractHarness | Promise<SessionRuntimeContractHarness>,
): SessionRuntimeContractCase[] {
  async function started(
    harness: SessionRuntimeContractHarness,
    overrides: Partial<SessionRuntimeSpec> = {},
  ): Promise<{ ref: SessionRuntimeRef; spec: SessionRuntimeSpec }> {
    const spec = harness.spec(overrides);
    const result = await harness.runtime.start(spec);
    assert.equal(result.ok, true, `start failed: ${result.ok ? '' : result.error.message}`);
    if (!result.ok) throw new Error('unreachable');
    return { ref: result.value, spec };
  }

  return [
    {
      name: 'start resolves once the runtime is ready',
      async run() {
        const harness = await createHarness();
        const { ref } = await started(harness);

        assert.equal(ref.provider.length > 0, true);
        assert.equal(ref.handle.length > 0, true);
        assert.match(ref.terminal.url, /^wss?:\/\//);

        const inspected = await harness.runtime.inspect(ref);
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;
        assert.equal(inspected.value.state, 'ready');
        assert.equal(inspected.value.ready, true);
        assert.equal(inspected.value.terminal?.url, ref.terminal.url);
      },
    },
    {
      name: 'list filters runtimes by Project',
      async run() {
        const harness = await createHarness();
        const projectA = `project-a-${++sequence}`;
        const projectB = `project-b-${++sequence}`;
        const first = await started(harness, { projectId: projectA });
        const second = await started(harness, { projectId: projectB });

        const listed = await harness.runtime.list({ projectId: projectA });
        assert.equal(listed.ok, true);
        if (!listed.ok) return;
        assert.deepEqual(
          listed.value.map((ref) => ref.sessionId),
          [first.ref.sessionId],
        );

        const all = await harness.runtime.list();
        assert.equal(all.ok, true);
        if (!all.ok) return;
        assert.deepEqual(
          all.value.map((ref) => ref.sessionId).sort(),
          [first.ref.sessionId, second.ref.sessionId].sort(),
        );
      },
    },
    {
      name: 'stop marks the runtime stopped and removes it from listing',
      async run() {
        const harness = await createHarness();
        const { ref } = await started(harness);

        const stopped = await harness.runtime.stop(ref);
        assert.equal(stopped.ok, true);

        const inspected = await harness.runtime.inspect(ref);
        assert.equal(inspected.ok, true);
        if (inspected.ok) {
          assert.equal(inspected.value.state, 'stopped');
          assert.equal(inspected.value.ready, false);
        }

        const listed = await harness.runtime.list({ projectId: ref.projectId });
        assert.equal(listed.ok, true);
        if (listed.ok) assert.deepEqual(listed.value, []);
      },
    },
    {
      name: 'stop is idempotent',
      async run() {
        const harness = await createHarness();
        const { ref } = await started(harness);

        assert.equal((await harness.runtime.stop(ref)).ok, true);
        assert.equal((await harness.runtime.stop(ref)).ok, true);
      },
    },
    {
      name: 'inspect rejects a ref it did not start',
      async run() {
        const harness = await createHarness();
        const { ref } = await started(harness);
        const missing: SessionRuntimeRef = { ...ref, sessionId: 'missing-session' };

        const inspected = await harness.runtime.inspect(missing);
        assert.equal(inspected.ok, false);
        if (!inspected.ok) assert.equal(inspected.error.kind, 'not-found');
      },
    },
    {
      name: 'start rejects an invalid spec',
      async run() {
        const harness = await createHarness();
        const result = await harness.runtime.start(harness.spec({ idea: '   ' }));

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.kind, 'invalid-input');
      },
    },
    {
      name: 'start surfaces the runtime failure reason',
      async run() {
        const harness = await createHarness();
        harness.failNextStart('ttyd: exec format error');

        const result = await harness.runtime.start(harness.spec());
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.kind, 'start-failed');
          assert.match(result.error.message, /exec format error/);
        }
      },
    },
  ];
}
