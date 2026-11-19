import { describe, expect, it } from 'vitest';
import { createMockK8sClient, type K8sClient, type K8sObject, type PodInfo } from '@yaaabk/k8s';
import {
  createKubernetesSessionRuntime,
  type KubernetesSessionRuntimeOptions,
} from './kubernetes-runtime';
import { sessionRuntimeContract } from './runtime-contract';
import type { SessionRuntimeSpec } from './runtime-types';
import { SESSION_PROMPT_ENV } from './supervisor';

const NAMESPACE = 'yaaabk-a1b2c3d4';
const REPO = 'acme/todo-app';

/**
 * A K8s client whose Pods become Ready with a Pod IP, because the in-memory
 * cluster has no kubelet. `failNextStart` makes the next started Pod report a
 * failing waiting state instead.
 */
function createReadyK8s(): {
  k8s: K8sClient;
  objectApi: ReturnType<typeof createMockK8sClient>['objectApi'];
  failNextStart(reason: string): void;
} {
  const mock = createMockK8sClient({
    // Reconciliation finds session Pods through the labelled Project Namespace.
    seed: [
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: NAMESPACE, labels: { 'yaaabk.io/project-name': 'todo-app' } },
      },
    ],
  });
  let nextFailure: string | undefined;
  let failingName: string | undefined;
  let reason = '';

  const k8s: K8sClient = {
    ...mock,
    pods: {
      ...mock.pods,
      create: async (namespace, name, spec) => {
        const created = await mock.pods.create(namespace, name, spec);
        if (nextFailure !== undefined) {
          failingName = name;
          reason = nextFailure;
          nextFailure = undefined;
        }
        return created;
      },
      get: async (namespace, name): Promise<Awaited<ReturnType<K8sClient['pods']['get']>>> => {
        const result = await mock.pods.get(namespace, name);
        if (!result.ok) return result;
        if (failingName === name) {
          return {
            ok: true,
            value: {
              ...result.value,
              phase: 'failed',
              ready: false,
              podIP: null,
              waitingReason: reason,
            } satisfies PodInfo,
          };
        }
        return {
          ok: true,
          value: {
            ...result.value,
            phase: 'running',
            ready: true,
            podIP: '10.42.0.9',
          } satisfies PodInfo,
        };
      },
    },
  };

  return {
    k8s,
    objectApi: mock.objectApi,
    failNextStart(message) {
      nextFailure = message;
    },
  };
}

function createHarness(overrides: Partial<KubernetesSessionRuntimeOptions> = {}) {
  const ready = createReadyK8s();
  const runtime = createKubernetesSessionRuntime({
    k8s: ready.k8s,
    image: 'ghcr.io/yaaabk/agent:test',
    probe: async () => true,
    sleep: async () => {},
    readinessTimeoutMs: 100,
    readinessPollMs: 1,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    credential: () => ({ username: 'yaaabk', token: 'terminal-token' }),
    ...overrides,
  });

  let sequence = 0;

  function spec(overrides: Partial<SessionRuntimeSpec> = {}): SessionRuntimeSpec {
    sequence += 1;
    return {
      sessionId: sequence === 1 ? 'session-next' : `session-next-${sequence}`,
      projectId: 'project-1',
      projectName: 'todo-app',
      namespace: NAMESPACE,
      repoFullName: REPO,
      gitToken: 'ghs_clone_token',
      idea: 'A todo app',
      skillLevel: 'expert',
      prompt: 'Build a todo app',
      model: 'openrouter/test-model',
      reportToken: 'report-token',
      apiUrl: 'http://backend:3000',
      ...overrides,
    };
  }

  return {
    runtime,
    ready,
    spec,
    /** A fresh adapter over the same cluster, as after a backend restart. */
    restart(): ReturnType<typeof createKubernetesSessionRuntime> {
      return createKubernetesSessionRuntime({
        k8s: ready.k8s,
        image: 'ghcr.io/yaaabk/agent:test',
        probe: async () => true,
        sleep: async () => {},
        readinessTimeoutMs: 100,
        readinessPollMs: 1,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        credential: () => ({ username: 'yaaabk', token: 'terminal-token' }),
        ...overrides,
      });
    },
    async pod(name = 'grill-session-next'): Promise<K8sObject> {
      return ready.objectApi.read({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, namespace: NAMESPACE },
      });
    },
  };
}

const contractCases = sessionRuntimeContract(() => {
  const harness = createHarness({
    readinessTimeoutMs: 20,
  });
  return {
    runtime: harness.runtime,
    spec: harness.spec,
    failNextStart(reason) {
      harness.ready.failNextStart(reason);
    },
  };
});

describe('Kubernetes SessionRuntime contract', () => {
  for (const contractCase of contractCases) {
    it(contractCase.name, contractCase.run);
  }
});

describe('Kubernetes session Pods', () => {
  it('runs the session in the Project Namespace as yaaabk-agent with Pod Security restricted', async () => {
    const harness = createHarness();

    const started = await harness.runtime.start(harness.spec());

    expect(started.ok).toBe(true);
    const pod = (await harness.pod()).spec as {
      serviceAccountName: string;
      securityContext: Record<string, unknown>;
      containers: Array<{
        name: string;
        securityContext: Record<string, unknown>;
        resources: unknown;
      }>;
    };
    expect(pod.serviceAccountName).toBe('yaaabk-agent');
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(pod.containers[0]?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      runAsNonRoot: true,
    });
    expect(pod.containers[0]?.resources).toEqual({
      requests: { cpu: '250m', memory: '256Mi' },
      limits: { cpu: '1', memory: '1Gi' },
    });
  });

  it('clones the repository with a read-only token only in the init container', async () => {
    const harness = createHarness();

    const started = await harness.runtime.start(harness.spec());
    expect(started.ok).toBe(true);

    const pod = (await harness.pod()).spec as {
      initContainers: Array<{
        name: string;
        command: string[];
        env?: Array<{ name: string }>;
        envFrom?: Array<{ secretRef: { name: string } }>;
        volumeMounts: Array<{ name: string; mountPath: string }>;
      }>;
      containers: Array<{
        name: string;
        env?: Array<{ name: string }>;
        envFrom?: Array<{ secretRef: { name: string } }>;
        volumeMounts: Array<{ name: string; mountPath: string }>;
      }>;
    };
    const clone = pod.initContainers.find((container) => container.name === 'clone');
    expect(clone).toBeDefined();
    const script = clone!.command.join('\n');
    expect(script).toContain('x-access-token:${GITHUB_TOKEN}');
    expect(script).toContain(REPO);
    expect(script).toContain('remote set-url');
    expect(clone!.envFrom).toEqual([{ secretRef: { name: 'grill-session-next-clone' } }]);

    const main = pod.containers.find((container) => container.name === 'session');
    const mainEnv = JSON.stringify(main);
    expect(mainEnv).not.toContain('GITHUB_TOKEN');
    expect(mainEnv).not.toContain('ghs_clone_token');
    expect(mainEnv).not.toContain('grill-session-next-clone');
    expect(main!.volumeMounts).toContainEqual({ name: 'workspace', mountPath: '/workspace' });
  });

  it('supervises opencode in tmux so a ttyd client disconnect cannot kill the agent', async () => {
    const harness = createHarness();
    const spec = harness.spec();

    await harness.runtime.start(spec);

    const pod = (await harness.pod()).spec as {
      containers: Array<{ command: string[]; args: string[] }>;
    };
    const args = pod.containers[0]!.args;
    expect(args.slice(args.indexOf('tmux'), args.indexOf('opencode'))).toEqual([
      'tmux',
      '-L',
      `yaaabk-${spec.sessionId}`,
      'new-session',
      '-A',
      '-s',
      `yaaabk-${spec.sessionId}`,
      'sh',
      '-c',
      expect.stringContaining('exec "$0" mini'),
    ]);
  });

  it('runs ttyd and opencode mini with the prompt, model and replay in the cloned repository', async () => {
    const harness = createHarness();

    const spec = harness.spec({ prompt: 'Build a recipe box', model: 'openrouter/test-model' });
    await harness.runtime.start(spec);

    const pod = (await harness.pod()).spec as {
      containers: Array<{
        name: string;
        command: string[];
        args: string[];
        workingDir: string;
        env: Array<{ name: string; value: string }>;
        envFrom?: Array<{ secretRef: { name: string } }>;
      }>;
    };
    const main = pod.containers[0]!;
    expect(main.command).toEqual(['ttyd']);
    expect(main.args).toEqual(
      expect.arrayContaining([
        '--writable',
        '--credential',
        'yaaabk:terminal-token',
        'sh',
        '-c',
        expect.stringContaining(`--prompt "$${SESSION_PROMPT_ENV}"`),
        'opencode',
        spec.sessionId,
        'openrouter/test-model',
      ]),
    );
    // ttyd 1.7.7 overflows a fixed 4096-byte title buffer when its command line
    // is long, so the prompt must reach OpenCode through the environment.
    expect(main.args).not.toContain('Build a recipe box');
    expect(main.workingDir).toBe('/workspace/repo');
    const env = Object.fromEntries(main.env.map((item) => [item.name, item.value]));
    expect(env).toMatchObject({
      YAAABK_PROJECT_ID: spec.projectId,
      YAAABK_SESSION_ID: spec.sessionId,
      YAAABK_SKILL_LEVEL: spec.skillLevel,
      [SESSION_PROMPT_ENV]: 'Build a recipe box',
      OPENCODE_CONFIG: '/app/opencode-session.json',
    });
    expect(main.envFrom).toEqual([{ secretRef: { name: 'grill-session-next-session' } }]);
  });

  it('restricts ingress to the backend and egress to the backend, the Kubernetes API, HTTPS and DNS', async () => {
    const harness = createHarness();

    await harness.runtime.start(harness.spec());

    const policy = (
      await harness.ready.objectApi.read({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'grill-session-next', namespace: NAMESPACE },
      })
    ).spec as {
      podSelector: { matchLabels: Record<string, string> };
      policyTypes: string[];
      ingress: Array<{ from?: unknown[]; ports?: unknown[] }>;
      egress: Array<{ to?: unknown[]; ports?: unknown[] }>;
    };

    expect(policy.podSelector.matchLabels).toEqual({ 'yaaabk.io/session-id': 'session-next' });
    expect(policy.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.ingress).toHaveLength(1);
    expect(policy.ingress[0]?.from).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'yaaabk' } },
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'yaaabk-backend' } },
      },
    ]);
    expect(policy.ingress[0]?.ports).toEqual([{ protocol: 'TCP', port: 7681 }]);

    const flatEgress = JSON.stringify(policy.egress);
    expect(flatEgress).toContain('"port":53');
    expect(flatEgress).toContain('"port":443');
    expect(flatEgress).toContain('"port":6443');
    expect(flatEgress).toContain('kubernetes.io/metadata.name');
    // The API server must be reachable on 443/6443 after kube-proxy DNATs the
    // `kubernetes` Service to a control-plane node. Peerless rules match every
    // destination; scoping them to an ipBlock (including 0.0.0.0/0) breaks
    // that on kube-router.
    expect(policy.egress).toContainEqual({
      ports: [
        { protocol: 'TCP', port: 443 },
        { protocol: 'TCP', port: 6443 },
      ],
    });
  });

  it('returns the Pod waiting reason when a session cannot start', async () => {
    const harness = createHarness();
    harness.ready.failNextStart('ErrImagePull: manifest unknown');

    const started = await harness.runtime.start(harness.spec({ sessionId: 'session-next' }));

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.kind).toBe('start-failed');
    expect(started.error.message).toContain('ErrImagePull: manifest unknown');
  });

  it('deletes the Pod, NetworkPolicy and per-session Secrets when stopped', async () => {
    const harness = createHarness();
    const started = await harness.runtime.start(harness.spec());
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await harness.runtime.stop(started.value);

    for (const [kind, name] of [
      ['Pod', 'grill-session-next'],
      ['NetworkPolicy', 'grill-session-next'],
      ['Secret', 'grill-session-next-clone'],
      ['Secret', 'grill-session-next-session'],
    ] as const) {
      const present = await harness.ready.objectApi
        .read({
          apiVersion: kind === 'NetworkPolicy' ? 'networking.k8s.io/v1' : 'v1',
          kind,
          metadata: { name, namespace: NAMESPACE },
        })
        .then(
          () => true,
          () => false,
        );
      expect(present, `${kind} ${name}`).toBe(false);
    }
  });
});

describe('Kubernetes session runtime across a backend restart', () => {
  it('rediscovers session Pods it did not start and can inspect them', async () => {
    const harness = createHarness();
    const started = await harness.runtime.start(harness.spec());
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // A new adapter process has no in-memory records.
    const restarted = harness.restart();
    const listed = await restarted.list();
    expect(listed.ok && listed.value.map((ref) => ref.sessionId)).toEqual(['session-next']);

    const inspected = await restarted.inspect(started.value);

    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.state).toBe('ready');
    expect(inspected.value.ready).toBe(true);
    // The Pod IP is rediscovered; the persisted ttyd credential is preserved.
    expect(inspected.value.terminal).toEqual({
      url: 'ws://10.42.0.9:7681/ws',
      credential: { username: 'yaaabk', token: 'terminal-token' },
    });
  });

  it('stops a rediscovered Pod and its resources', async () => {
    const harness = createHarness();
    const started = await harness.runtime.start(harness.spec());
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const restarted = harness.restart();
    const listed = await restarted.list();
    const ref = listed.ok ? listed.value[0] : undefined;
    expect(ref).toBeDefined();
    if (ref === undefined) return;

    const stopped = await restarted.stop(ref);

    expect(stopped.ok).toBe(true);
    const present = await harness.ready.objectApi
      .read({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'grill-session-next', namespace: NAMESPACE },
      })
      .then(
        () => true,
        () => false,
      );
    expect(present).toBe(false);
  });

  it('reports a session whose Pod is gone as failed with the Pod reason', async () => {
    const harness = createHarness();
    const started = await harness.runtime.start(harness.spec());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await harness.ready.objectApi.delete({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'grill-session-next', namespace: NAMESPACE },
    });

    const inspected = await harness.restart().inspect(started.value);

    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.state).toBe('failed');
    expect(inspected.value.reason).toContain('Pod "grill-session-next"');
  });
});
