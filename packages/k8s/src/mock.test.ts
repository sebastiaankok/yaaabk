import { describe, expect, it } from 'vitest';
import { createMockK8sClient } from './mock';
import type { K8sObject } from './object-api';

const existingNamespace: K8sObject = {
  apiVersion: 'v1',
  kind: 'Namespace',
  metadata: { name: 'project-a', labels: { 'yaaabk.io/project-name': 'todo' } },
};

describe('createMockK8sClient', () => {
  it('starts from the seeded cluster state', async () => {
    const k8s = createMockK8sClient({ seed: [existingNamespace] });

    const result = await k8s.namespaces.get('project-a');

    expect(result.ok && result.value.name).toBe('project-a');
  });

  it('behaves like a cluster across a full agent-job lifecycle', async () => {
    const k8s = createMockK8sClient();

    await k8s.namespaces.create('project-a', { labels: { 'yaaabk.io/project-name': 'todo' } });
    await k8s.serviceAccounts.create('project-a', 'agent-a1b2c3d4');
    await k8s.jobs.create('project-a', 'agent-42', { image: 'yaaabk/agent:test' });

    const jobs = await k8s.jobs.list('project-a');
    expect(jobs.ok && jobs.value.map((job) => job.name)).toEqual(['agent-42']);

    expect(await k8s.jobs.delete('project-a', 'agent-42')).toEqual({ ok: true, value: undefined });
    const afterDelete = await k8s.jobs.list('project-a');
    expect(afterDelete.ok && afterDelete.value).toEqual([]);
  });
});
