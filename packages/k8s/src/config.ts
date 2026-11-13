/** How the client reaches the cluster. */
export type K8sConnectionMode = 'in-cluster' | 'kubeconfig';

export interface K8sConnectionConfig {
  mode: K8sConnectionMode;
  /** Explicit kubeconfig file, when {@link mode} is `kubeconfig`. */
  kubeconfigPath?: string;
  /** Named context to select from the kubeconfig. */
  context?: string;
}

/**
 * Decides whether YAAABK is running inside a pod or on a developer machine.
 *
 * Kubernetes injects `KUBERNETES_SERVICE_HOST` into every pod, so its presence
 * is the signal for in-cluster config. Otherwise the standard kubeconfig
 * resolution applies, honouring `KUBECONFIG` when set.
 */
export function detectK8sConnection(
  env: Record<string, string | undefined> = process.env,
): K8sConnectionConfig {
  const serviceHost = env.KUBERNETES_SERVICE_HOST;
  if (serviceHost !== undefined && serviceHost.trim() !== '') {
    return { mode: 'in-cluster' };
  }

  const kubeconfigPath = env.KUBECONFIG;
  if (kubeconfigPath !== undefined && kubeconfigPath.trim() !== '') {
    return { mode: 'kubeconfig', kubeconfigPath };
  }

  return { mode: 'kubeconfig' };
}
