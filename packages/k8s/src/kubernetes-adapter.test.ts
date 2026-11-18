import { KubeConfig } from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createKubernetesObjectApi, type ContainerLogReader } from './kubernetes-adapter';

/** A Pod ref; the adapter needs no cluster for the cases below. */
const POD = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'agent-1', namespace: 'project-a' },
};

/** A config the API client accepts at construction; nothing here dials it. */
function testKubeConfig(): KubeConfig {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://cluster.invalid', skipTLSVerify: true }],
    users: [{ name: 'test', token: 'test-token' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  });
  return config;
}

/** Reads a byte stream to text. */
async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

/** A log client that can refuse the first request the way the kubelet does. */
function scriptedLogReader(
  script: Array<'no-content' | 'creating' | { write: string }>,
  onAttempt?: () => void,
): ContainerLogReader {
  return {
    async log(_namespace, _pod, _container, stream) {
      onAttempt?.();
      const step = script.shift();
      if (step === 'no-content') {
        throw Object.assign(new Error('Error occurred in log request'), { code: 204 });
      }
      if (step === 'creating') {
        // The shape @kubernetes/client-node throws for a 400 while the
        // container is still being created.
        throw Object.assign(
          new Error(
            'HTTP-Code: 400\nMessage: container "agent" in pod "agent-1" is waiting to start: ContainerCreating\nBody: undefined',
          ),
          { code: 400 },
        );
      }
      if (step === undefined) throw new Error('unexpected extra log request');
      const sink = stream as PassThrough;
      sink.write(step.write);
      sink.end();
      return new AbortController();
    },
  };
}

describe('createKubernetesObjectApi logs', () => {
  it('waits out a 204 until the container writes its first line', async () => {
    let attempts = 0;
    const api = createKubernetesObjectApi({
      connection: { mode: 'kubeconfig' },
      kubeConfig: testKubeConfig(),
      logRetryMs: 0,
      logReader: scriptedLogReader(['no-content', { write: 'starting\n' }], () => {
        attempts += 1;
      }),
    });

    const stream = await api.logs(POD, { follow: true, container: 'agent' });

    await expect(streamText(stream)).resolves.toBe('starting\n');
    expect(attempts).toBe(2);
  });

  it('waits out a 400 until the container has been created', async () => {
    let attempts = 0;
    const api = createKubernetesObjectApi({
      connection: { mode: 'kubeconfig' },
      kubeConfig: testKubeConfig(),
      logRetryMs: 0,
      logReader: scriptedLogReader(['creating', { write: 'starting\n' }], () => {
        attempts += 1;
      }),
    });

    const stream = await api.logs(POD, { follow: true, container: 'agent' });

    await expect(streamText(stream)).resolves.toBe('starting\n');
    expect(attempts).toBe(2);
  });

  it('treats a 204 as an empty log when not following', async () => {
    let attempts = 0;
    const api = createKubernetesObjectApi({
      connection: { mode: 'kubeconfig' },
      kubeConfig: testKubeConfig(),
      logRetryMs: 0,
      logReader: scriptedLogReader(['no-content'], () => {
        attempts += 1;
      }),
    });

    const stream = await api.logs(POD, { container: 'agent' });

    await expect(streamText(stream)).resolves.toBe('');
    expect(attempts).toBe(1);
  });

  it('surfaces any other log failure to the reader', async () => {
    const api = createKubernetesObjectApi({
      connection: { mode: 'kubeconfig' },
      kubeConfig: testKubeConfig(),
      logReader: {
        async log() {
          throw Object.assign(new Error('pods "agent-1" is forbidden'), { code: 403 });
        },
      },
    });

    const stream = await api.logs(POD, { container: 'agent' });

    await expect(streamText(stream)).rejects.toThrow('forbidden');
  });
});
