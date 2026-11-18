import { describe, expect, it } from 'vitest';
import { createK8sClient } from './client';
import { silentLogger } from './errors';
import { createInMemoryObjectApi } from './in-memory-object-api';
import type { K8sObject } from './object-api';
import type { PodSpec } from './types';

function readyPod(phase: string, overrides: Record<string, unknown> = {}): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'grill-1', namespace: 'yaaabk-a1b2c3d4', labels: { app: 'grill' } },
    status: {
      phase,
      podIP: '10.42.0.7',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        { name: 'session', ready: true, state: { running: { startedAt: '2026-01-01' } } },
      ],
      ...overrides,
    },
  };
}

const podSpec: PodSpec = {
  serviceAccountName: 'yaaabk-agent',
  labels: { 'yaaabk.io/session-id': 'grill-1' },
  containers: [
    {
      name: 'session',
      image: 'agent:1',
      env: { YAAABK_SESSION_ID: 'grill-1' },
      resources: {
        requests: { cpu: '250m', memory: '256Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
      securityContext: { allowPrivilegeEscalation: false },
    },
  ],
  initContainers: [{ name: 'clone', image: 'agent:1', command: ['sh', '-c', 'git clone'] }],
  securityContext: { runAsNonRoot: true },
};

describe('pods', () => {
  it('creates a Pod in a Project Namespace with its containers, init containers and security context', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const created = await client.pods.create('yaaabk-a1b2c3d4', 'grill-1', podSpec);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      name: 'grill-1',
      namespace: 'yaaabk-a1b2c3d4',
      labels: { 'yaaabk.io/session-id': 'grill-1' },
    });

    const stored = await objectApi.read({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'grill-1', namespace: 'yaaabk-a1b2c3d4' },
    });
    expect(stored.spec).toMatchObject({
      serviceAccountName: 'yaaabk-agent',
      securityContext: { runAsNonRoot: true },
      initContainers: [{ name: 'clone', image: 'agent:1' }],
      containers: [
        {
          name: 'session',
          resources: {
            requests: { cpu: '250m', memory: '256Mi' },
            limits: { cpu: '1', memory: '1Gi' },
          },
        },
      ],
    });
  });

  it('reports the Pod phase, IP, readiness and a container waiting reason', async () => {
    const objectApi = createInMemoryObjectApi([
      readyPod('Pending', {
        podIP: undefined,
        conditions: [{ type: 'Ready', status: 'False' }],
        containerStatuses: [
          {
            name: 'session',
            ready: false,
            state: {
              waiting: { reason: 'ErrImagePull', message: 'manifest unknown' },
            },
          },
        ],
      }),
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.pods.get('yaaabk-a1b2c3d4', 'grill-1');

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'grill-1',
        namespace: 'yaaabk-a1b2c3d4',
        labels: { app: 'grill' },
        phase: 'pending',
        podIP: null,
        ready: false,
        waitingReason: 'ErrImagePull: manifest unknown',
        terminationReason: null,
        exitCode: null,
      },
    });
  });

  it('lists Pods by namespace and label', async () => {
    const objectApi = createInMemoryObjectApi([
      readyPod('Running'),
      {
        ...readyPod('Running'),
        metadata: { name: 'other', namespace: 'yaaabk-a1b2c3d4', labels: { app: 'other' } },
      },
      {
        ...readyPod('Running'),
        metadata: { name: 'elsewhere', namespace: 'yaaabk-b2c3d4e5', labels: { app: 'grill' } },
      },
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.pods.list('yaaabk-a1b2c3d4', { app: 'grill' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((pod) => pod.name)).toEqual(['grill-1']);
  });

  it('deletes a Pod', async () => {
    const objectApi = createInMemoryObjectApi([readyPod('Running')]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    expect((await client.pods.delete('yaaabk-a1b2c3d4', 'grill-1')).ok).toBe(true);

    const result = await client.pods.get('yaaabk-a1b2c3d4', 'grill-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-found');
  });
});

describe('networkPolicies', () => {
  it('creates, reads and deletes a NetworkPolicy in a Project Namespace', async () => {
    const client = createK8sClient({
      objectApi: createInMemoryObjectApi(),
      logger: silentLogger,
    });

    const created = await client.networkPolicies.create('yaaabk-a1b2c3d4', 'grill-1', {
      podSelector: { matchLabels: { 'yaaabk.io/session-id': 'grill-1' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'yaaabk' } } },
          ],
        },
      ],
      egress: [
        {
          to: [
            { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'yaaabk' } } },
            { ipBlock: { cidr: '0.0.0.0/0' } },
          ],
          ports: [{ protocol: 'TCP', port: 443 }],
        },
      ],
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      name: 'grill-1',
      namespace: 'yaaabk-a1b2c3d4',
      policyTypes: ['Ingress', 'Egress'],
    });

    const read = await client.networkPolicies.get('yaaabk-a1b2c3d4', 'grill-1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.policyTypes).toEqual(['Ingress', 'Egress']);

    expect((await client.networkPolicies.delete('yaaabk-a1b2c3d4', 'grill-1')).ok).toBe(true);
    expect((await client.networkPolicies.get('yaaabk-a1b2c3d4', 'grill-1')).ok).toBe(false);
  });

  it('lists NetworkPolicies in a Project Namespace', async () => {
    const objectApi = createInMemoryObjectApi([
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'grill-1', namespace: 'yaaabk-a1b2c3d4', labels: { app: 'grill' } },
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      },
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.networkPolicies.list('yaaabk-a1b2c3d4', { app: 'grill' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((policy) => policy.name)).toEqual(['grill-1']);
  });
});
