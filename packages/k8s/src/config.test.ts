import { describe, expect, it } from 'vitest';
import { detectK8sConnection, ensureInClusterCaTrusted, IN_CLUSTER_CA_PATH } from './config';

describe('detectK8sConnection', () => {
  it('detects in-cluster config from the injected service host', () => {
    expect(
      detectK8sConnection({ KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' }),
    ).toEqual({ mode: 'in-cluster' });
  });

  it('falls back to the default kubeconfig when not running in a pod', () => {
    expect(detectK8sConnection({})).toEqual({ mode: 'kubeconfig' });
  });

  it('honours an explicit KUBECONFIG path', () => {
    expect(detectK8sConnection({ KUBECONFIG: '/home/dev/.kube/config' })).toEqual({
      mode: 'kubeconfig',
      kubeconfigPath: '/home/dev/.kube/config',
    });
  });

  it('ignores an empty service host', () => {
    expect(detectK8sConnection({ KUBERNETES_SERVICE_HOST: '  ' })).toEqual({ mode: 'kubeconfig' });
  });
});

describe('ensureInClusterCaTrusted', () => {
  it('points Node at the service-account CA when in-cluster and none is configured', () => {
    const env: Record<string, string | undefined> = {
      KUBERNETES_SERVICE_HOST: '10.96.0.1',
      NODE_EXTRA_CA_CERTS: undefined,
    };

    ensureInClusterCaTrusted(env, () => true);

    expect(env.NODE_EXTRA_CA_CERTS).toBe('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  });

  it('leaves an explicit NODE_EXTRA_CA_CERTS alone', () => {
    const env: Record<string, string | undefined> = {
      KUBERNETES_SERVICE_HOST: '10.96.0.1',
      NODE_EXTRA_CA_CERTS: '/custom/ca.pem',
    };

    ensureInClusterCaTrusted(env, () => true);

    expect(env.NODE_EXTRA_CA_CERTS).toBe('/custom/ca.pem');
  });

  it('does nothing outside a cluster', () => {
    const env: Record<string, string | undefined> = { NODE_EXTRA_CA_CERTS: undefined };

    ensureInClusterCaTrusted(env, () => true);

    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('does nothing when the CA file is absent', () => {
    const env: Record<string, string | undefined> = {
      KUBERNETES_SERVICE_HOST: '10.96.0.1',
      NODE_EXTRA_CA_CERTS: undefined,
    };

    ensureInClusterCaTrusted(env, () => false);

    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('uses the standard service-account CA path', () => {
    expect(IN_CLUSTER_CA_PATH).toBe('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  });
});
