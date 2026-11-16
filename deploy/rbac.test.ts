import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Rule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

interface Doc {
  kind: string;
  name: string;
  namespace?: string;
  rules: Rule[];
  roleRef?: string;
  subject?: string;
}

/** Parses the single-document-per-`---` YAML closely enough for assertions. */
function documents(): Doc[] {
  const text = readFileSync(fileURLToPath(new URL('../deploy/rbac.yaml', import.meta.url)), 'utf8');
  return text
    .split(/^---$/m)
    .map((part) => part.trim())
    .filter((part) => /^apiVersion:/m.test(part))
    .map((part) => ({
      kind: /^kind:\s*(\S+)/m.exec(part)?.[1] ?? '',
      name: /^metadata:\n(?: {2}\S.*\n)*? {2}name:\s*(\S+)/m.exec(part)?.[1] ?? '',
      namespace: / {2}namespace:\s*(\S+)/m.exec(part)?.[1],
      roleRef:
        /kind: Role\n {2}name: (\S+)/m.exec(part)?.[1] ??
        /name: (\S+)\n {2}subjects/m.exec(part)?.[1],
      subject: /^ {2}- kind: ServiceAccount\n {4}name: (\S+)$/m.exec(part)?.[1],
      rules: [
        ...part.matchAll(
          /- apiGroups: \[(.*?)\][\s\S]*?resources: \[(.*?)\][\s\S]*?verbs: \[(.*?)\]/g,
        ),
      ].map((m) => ({
        apiGroups: m[1].split(',').map((s) => s.trim().replaceAll("'", '')),
        resources: m[2].split(',').map((s) => s.trim()),
        verbs: m[3].split(',').map((s) => s.trim()),
      })),
    }));
}

describe('deploy/rbac.yaml', () => {
  it('binds no ClusterRole to the backend at all', () => {
    const clusterBindings = documents().filter((doc) => doc.kind === 'ClusterRoleBinding');
    expect(clusterBindings).toHaveLength(0);
  });

  it('limits agent Jobs, PVCs and Secrets to the yaaabk namespace', () => {
    const role = documents().find(
      (doc) =>
        doc.kind === 'Role' && doc.name === 'yaaabk-backend-agent' && doc.namespace === 'yaaabk',
    );
    expect(role, 'yaaabk-backend-agent Role in yaaabk not found').toBeDefined();

    const rules = role!.rules;
    expect(rules.find((r) => r.resources.includes('jobs'))?.apiGroups).toEqual(['batch']);
    expect(rules.find((r) => r.resources.includes('persistentvolumeclaims'))?.apiGroups).toEqual([
      '',
    ]);
    expect(rules.find((r) => r.resources.includes('secrets'))?.apiGroups).toEqual(['']);
    // Nothing else: the backend must hold no other namespaced rights.
    const resources = [...new Set(rules.flatMap((r) => r.resources))].sort();
    expect(resources).toEqual(['jobs', 'persistentvolumeclaims', 'secrets']);
  });

  it('limits ArgoCD Applications to the yaaabk namespace', () => {
    const role = documents().find(
      (doc) =>
        doc.kind === 'Role' && doc.name === 'yaaabk-backend-argocd' && doc.namespace === 'yaaabk',
    );
    expect(role, 'yaaabk-backend-argocd Role in yaaabk not found').toBeDefined();
    const argo = role!.rules.find((r) => r.apiGroups.includes('argoproj.io'));
    expect(argo?.resources).toEqual(['applications']);
    // AppProjects are cluster-scoped and GitOps-managed; the backend never
    // touches them.
    expect(argo?.resources).not.toContain('appprojects');
  });

  it('binds each Role only in its own namespace', () => {
    const bindings = documents().filter((doc) => doc.kind === 'RoleBinding');
    const subjects = bindings.map((doc) => `${doc.name}@${doc.namespace}->${doc.subject}`);
    expect(subjects).toContain('yaaabk-backend-agent@yaaabk->yaaabk-backend');
    expect(subjects).toContain('yaaabk-backend-argocd@yaaabk->yaaabk-backend');
  });
});
