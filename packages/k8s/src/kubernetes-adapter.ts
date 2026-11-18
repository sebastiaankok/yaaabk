import { KubeConfig, KubernetesObjectApi, Log, Watch } from '@kubernetes/client-node';
import { PassThrough, Readable } from 'node:stream';
import { detectK8sConnection, type K8sConnectionConfig } from './config';
import type { K8sObject, ListOptions, LogOptions, ObjectApi } from './object-api';
import { labelSelector, resourcePath } from './selectors';

export interface KubernetesAdapterOptions {
  /** Overrides in-cluster/kubeconfig auto-detection. */
  connection?: K8sConnectionConfig;
  /** Pre-built config, mainly for tests that point at a kind cluster. */
  kubeConfig?: KubeConfig;
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
  const logReader = new Log(kubeConfig);

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
      const container = options.container ?? (await firstContainerName(ref.metadata));
      const sink = new PassThrough();
      const upstream = await logReader.log(
        ref.metadata.namespace,
        ref.metadata.name,
        container,
        sink,
        {
          follow: options.follow ?? false,
          ...(options.tailLines === undefined ? {} : { tailLines: options.tailLines }),
        },
      );
      const reader = Readable.toWeb(sink).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value as Uint8Array);
        },
        async cancel(reason) {
          upstream.abort();
          await reader.cancel(reason);
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
