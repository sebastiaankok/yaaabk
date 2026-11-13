import { KubeConfig, KubernetesObjectApi, Watch } from '@kubernetes/client-node';
import { detectK8sConnection, type K8sConnectionConfig } from './config';
import type { K8sObject, ListOptions, ObjectApi } from './object-api';
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
