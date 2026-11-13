import { describe, expect, it } from 'vitest';
import { detectK8sConnection } from './config';

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
