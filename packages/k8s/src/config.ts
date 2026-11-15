import { existsSync } from 'node:fs';

/** How the client reaches the cluster. */
export type K8sConnectionMode = 'in-cluster' | 'kubeconfig';

/** The CA Kubernetes projects into every pod, when running in-cluster. */
export const IN_CLUSTER_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

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

/**
 * Makes the in-cluster API server's certificate trusted by Node's TLS stack.
 *
 * `@kubernetes/client-node` loads the service-account CA for its own request
 * options, but Bun's undici build ignores it and fails every in-cluster call
 * with `self signed certificate in certificate chain`. Pointing
 * `NODE_EXTRA_CA_CERTS` at the same CA file fixes trust for every fetch the
 * process makes, with certificate validation left on. A no-op outside a pod,
 * when an explicit CA is configured, or when the file is missing. Must run
 * before the first TLS connection is opened.
 */
export function ensureInClusterCaTrusted(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): void {
  if (detectK8sConnection(env).mode !== 'in-cluster') {
    return;
  }
  if (env.NODE_EXTRA_CA_CERTS !== undefined && env.NODE_EXTRA_CA_CERTS !== '') {
    return;
  }
  if (!exists(IN_CLUSTER_CA_PATH)) {
    return;
  }
  env.NODE_EXTRA_CA_CERTS = IN_CLUSTER_CA_PATH;
}
