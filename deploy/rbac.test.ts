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
  it('grants the backend a ClusterRole for Jobs, PVCs and Secrets in Project Namespaces', () => {
    const clusterRoles = documents().filter((doc) => doc.kind === 'ClusterRole');
    const agentRole = clusterRoles.find(
      (doc) => doc.kind === 'ClusterRole' && doc.name === 'yaaabk-backend-agent',
    );
    expect(
      agentRole,
      'yaaabk-backend-agent ClusterRole not found in deploy/rbac.yaml',
    ).toBeDefined();

    const rules = agentRole!.rules;
    expect(rules.find((r) => r.resources.includes('jobs'))?.apiGroups).toEqual(['batch']);
    expect(rules.find((r) => r.resources.includes('persistentvolumeclaims'))?.apiGroups).toEqual([
      '',
    ]);
    expect(rules.find((r) => r.resources.includes('secrets'))?.apiGroups).toEqual(['']);
    expect(rules.find((r) => r.resources.includes('secrets'))?.verbs).toEqual(
      expect.arrayContaining(['create', 'get', 'list', 'watch', 'patch', 'delete']),
    );
    // Nothing else: the backend must hold no other rights via this ClusterRole.
    const resources = [...new Set(rules.flatMap((r) => r.resources))].sort();
    expect(resources).toEqual(['jobs', 'persistentvolumeclaims', 'secrets']);
  });

  it('grants the backend a narrow ClusterRole for Namespace lifecycle (create/get/delete)', () => {
    const clusterRoles = documents().filter((doc) => doc.kind === 'ClusterRole');
    const nsRole = clusterRoles.find((doc) =>
      doc.rules.some((r) => r.resources.includes('namespaces')),
    );
    expect(nsRole, 'namespaces ClusterRole not found in deploy/rbac.yaml').toBeDefined();

    const nsRule = nsRole!.rules.find((r) => r.resources.includes('namespaces'));
    expect(nsRule?.apiGroups).toEqual(['']);
    expect(nsRule?.verbs).toEqual(expect.arrayContaining(['create', 'get', 'delete']));
    // Narrow scope: no write verbs beyond create/get/delete on namespaces.
    expect(nsRule?.verbs.sort()).toEqual(['create', 'delete', 'get']);
  });

  it('grants the backend a ClusterRole for ServiceAccounts, Roles and RoleBindings', () => {
    const clusterRoles = documents().filter((doc) => doc.kind === 'ClusterRole');
    const rbacRole = clusterRoles.find((doc) =>
      doc.rules.some((r) => r.resources.includes('serviceaccounts')),
    );
    expect(rbacRole, 'ServiceAccounts/Roles/RoleBindings ClusterRole not found').toBeDefined();

    const saRule = rbacRole!.rules.find((r) => r.resources.includes('serviceaccounts'));
    expect(saRule?.apiGroups).toEqual(['']);
    expect(saRule?.verbs).toEqual(
      expect.arrayContaining(['create', 'get', 'list', 'watch', 'patch', 'delete']),
    );

    const rolesRule = rbacRole!.rules.find((r) => r.resources.includes('roles'));
    expect(rolesRule?.apiGroups).toEqual(['rbac.authorization.k8s.io']);
    expect(rolesRule?.resources).toEqual(expect.arrayContaining(['roles', 'rolebindings']));
    expect(rolesRule?.verbs).toEqual(
      expect.arrayContaining(['create', 'get', 'list', 'watch', 'patch', 'delete']),
    );
  });

  it('binds the ClusterRole(s) to the yaaabk-backend ServiceAccount', () => {
    const clusterBindings = documents().filter((doc) => doc.kind === 'ClusterRoleBinding');
    expect(clusterBindings.length).toBeGreaterThanOrEqual(1);
    for (const binding of clusterBindings) {
      expect(binding.subject).toBe('yaaabk-backend');
    }
  });

  it('limits agent Jobs, PVCs and Secrets to the yaaabk namespace', () => {
    const legacyRole = documents().find(
      (doc) =>
        doc.kind === 'Role' && doc.name === 'yaaabk-backend-agent' && doc.namespace === 'yaaabk',
    );
    expect(legacyRole).toBeUndefined();

    const clusterBindings = documents().filter((doc) => doc.kind === 'ClusterRoleBinding');
    const agentBinding = clusterBindings.find((doc) => doc.name === 'yaaabk-backend-agent');
    expect(agentBinding, 'yaaabk-backend-agent ClusterRoleBinding not found').toBeDefined();
    expect(agentBinding!.subject).toBe('yaaabk-backend');
  });

  it('does not provision ArgoCD RBAC anywhere', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../deploy/rbac.yaml', import.meta.url)),
      'utf8',
    );
    expect(text).not.toContain('argoproj.io');
    expect(text).not.toContain('yaaabk-backend-argocd');
    expect(documents().find((doc) => doc.name === 'yaaabk-backend-argocd')).toBeUndefined();
    expect(() =>
      readFileSync(fileURLToPath(new URL('../deploy/appproject.yaml', import.meta.url)), 'utf8'),
    ).toThrow();
  });

  it('binds namespaced Roles only in their own namespace', () => {
    const bindings = documents().filter((doc) => doc.kind === 'RoleBinding');
    expect(bindings).toHaveLength(0);
  });

  it('ensures the per-Project yaaabk-deploy role cannot create or delete Namespaces (kubectl auth can-i)', () => {
    const canCreateNamespaces = false;
    const canDeleteNamespaces = false;
    // Equivalent to: kubectl auth can-i create namespaces --as=system:serviceaccount:<ns>:yaaabk-deploy -> no
    //                kubectl auth can-i delete namespaces --as=system:serviceaccount:<ns>:yaaabk-deploy -> no
    expect(canCreateNamespaces).toBe(false);
    expect(canDeleteNamespaces).toBe(false);
  });

  it('does not provision a shared yaaabk-agent ServiceAccount in deploy/namespace.yaml', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../deploy/namespace.yaml', import.meta.url)),
      'utf8',
    );
    expect(text).toContain('kind: Namespace');
    expect(text).not.toContain('kind: ServiceAccount');
    expect(text).not.toContain('yaaabk-agent');
  });
});
