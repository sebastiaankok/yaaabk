import { KubeConfig, KubernetesObjectApi, Log, Watch } from '@kubernetes/client-node';
import { PassThrough, Readable } from 'node:stream';
import { detectK8sConnection, type K8sConnectionConfig } from './config';
import type { K8sObject, ListOptions, LogOptions, ObjectApi } from './object-api';
import { labelSelector, resourcePath } from './selectors';

/**
 * What the adapter needs from a container-log client.
 *
 * Narrowed so tests can script an empty response (a container that has not
 * written anything yet answers HTTP 204) without a cluster.
 */
export interface ContainerLogReader {
  log(
    namespace: string,
    podName: string,
    containerName: string,
    stream: NodeJS.WritableStream,
    options?: { follow?: boolean; tailLines?: number },
  ): Promise<AbortController>;
}

export interface KubernetesAdapterOptions {
  /** Overrides in-cluster/kubeconfig auto-detection. */
  connection?: K8sConnectionConfig;
  /** Pre-built config, mainly for tests that point at a kind cluster. */
  kubeConfig?: KubeConfig;
  /** Container-log client. Defaults to the real API; tests inject a fake. */
  logReader?: ContainerLogReader;
  /** How long to wait before re-asking for a log that has no output yet. */
  logRetryMs?: number;
}

/** A function that yields the next chunk of a stream, or null at its end. */
type ChunkReader = () => Promise<Uint8Array | null>;

/**
 * Whether a log request failed only because the container has no log yet.
 *
 * Kubernetes answers 204 from the moment a Pod starts until its first byte of
 * output. While the container is still being created — which is exactly when
 * the UI opens the live stream — it answers 400 with "container … is waiting to
 * start: ContainerCreating". Both mean "nothing to read yet", not a failure.
 */
function isLogNotReady(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 204) return true;
  if (code !== 400) return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    /is waiting to start|PodInitializing|ContainerCreating/.test(message)
  );
}

function buildKubeConfig(connection: K8sConnectionConfig): KubeConfig {
  const kubeConfig = new KubeConfig();
  if (connection.mode === 'in-cluster') {
    kubeConfig.loadFromCluster();
  } else if (connection.kubeconfigPath !== undefined) {
    kubeConfig.loadFromFile(connection.kubeconfigPath);
  } else {
    kubeConfig.loadFromDefault();
  }
  if (connection.context !== undefined) {
    kubeConfig.setCurrentContext(connection.context);
  }
  return kubeConfig;
}

/**
 * The real {@link ObjectApi}, backed by `@kubernetes/client-node`.
 *
 * Every method here is a thin translation: the YAAABK-specific decisions all
 * live in the high-level client, and this file is the only place that knows
 * about `@kubernetes/client-node`.
 */
export function createKubernetesObjectApi(options: KubernetesAdapterOptions = {}): ObjectApi {
  const connection = options.connection ?? detectK8sConnection();
  const kubeConfig = options.kubeConfig ?? buildKubeConfig(connection);
  const objects = KubernetesObjectApi.makeApiClient(kubeConfig);
  const watcher = new Watch(kubeConfig);
  const logReader = options.logReader ?? new Log(kubeConfig);
  const logRetryMs = options.logRetryMs ?? 1_000;

  /** The first container's name, which the log endpoint needs explicitly. */
  async function firstContainerName(ref: K8sObject['metadata']): Promise<string> {
    const pod = (await objects.read({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: ref,
    })) as unknown as K8sObject;
    const containers = (pod.spec as { containers?: Array<{ name?: string }> } | undefined)
      ?.containers;
    const name = containers?.[0]?.name;
    if (name === undefined || name === '') {
      throw new Error(`Pod ${ref.name} has no containers to read logs from`);
    }
    return name;
  }

  return {
    async create(spec) {
      return (await objects.create(spec)) as unknown as K8sObject;
    },

    async read(ref) {
      return (await objects.read(ref)) as unknown as K8sObject;
    },

    async list(apiVersion, kind, listOptions: ListOptions = {}) {
      const list = await objects.list(
        apiVersion,
        kind,
        listOptions.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector(listOptions.labels),
      );
      return (list.items ?? []) as unknown as K8sObject[];
    },

    async patch(spec) {
      return (await objects.patch(spec)) as unknown as K8sObject;
    },

    async delete(ref) {
      await objects.delete(ref);
    },

    async logs(ref, options: LogOptions = {}) {
      if (ref.metadata.namespace === undefined) {
        throw new Error(`Pod ${ref.metadata.name} needs a namespace to read logs`);
      }
      const namespace = ref.metadata.namespace;
      const container = options.container ?? (await firstContainerName(ref.metadata));
      const follow = options.follow ?? false;
      const logOptions = {
        follow,
        ...(options.tailLines === undefined ? {} : { tailLines: options.tailLines }),
      };

      let cancelled = false;
      let upstream: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      let read: ChunkReader | undefined;

      const pause = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, ms);
        });

      /**
       * Opens the log, waiting out a "not ready" answer.
       *
       * A Job's container answers 204 (or 400 while it is still being created)
       * from the moment the Pod starts until its first byte of output, which is
       * exactly when the UI opens the stream. Treating that as an error made a
       * starting attempt look broken, so when following, poll until there is a
       * log to read instead.
       */
      async function connect(): Promise<void> {
        while (!cancelled) {
          try {
            const sink = new PassThrough();
            upstream = await logReader.log(
              namespace,
              ref.metadata.name,
              container,
              sink,
              logOptions,
            );
            const reader = Readable.toWeb(sink).getReader();
            read = async () => {
              const { done, value } = await reader.read();
              return done ? null : (value as Uint8Array);
            };
            return;
          } catch (error) {
            if (!isLogNotReady(error)) throw error;
            if (!follow) {
              read = async () => null;
              return;
            }
            await pause(logRetryMs);
          }
        }
        read = async () => null;
      }

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (read === undefined) await connect();
            const chunk = await read?.();
            if (cancelled) return;
            if (chunk === undefined || chunk === null) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel() {
          cancelled = true;
          if (timer !== undefined) clearTimeout(timer);
          wake?.();
          upstream?.abort();
        },
      });
    },

    async watch(ref, onEvent) {
      const controller = await watcher.watch(
        resourcePath(ref.apiVersion, ref.kind, ref.metadata.namespace),
        { fieldSelector: `metadata.name=${ref.metadata.name}` },
        (_phase, object) => onEvent(object as K8sObject),
        () => {},
      );
      return () => controller.abort();
    },
  };
}
