import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Rule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

interface ClusterRoleDoc {
  kind: string;
  metadata: { name: string };
  rules: Rule[];
}

/** Parses the single-document-per-`---` YAML closely enough for assertions. */
function clusterRoleRules(): Rule[] {
  const text = readFileSync(fileURLToPath(new URL('../deploy/rbac.yaml', import.meta.url)), 'utf8');
  const doc = text
    .split(/^---$/m)
    .map((part) => part.trim())
    .filter((part) => part.startsWith('apiVersion:'))
    .map(
      (part) =>
        ({
          kind: /^kind:\s*(\S+)/m.exec(part)?.[1] ?? '',
          metadata: { name: /^metadata:\n\s+name:\s*(\S+)/m.exec(part)?.[1] ?? '' },
          rules: [...part.matchAll(/- apiGroups: \[(.*?)\][\s\S]*?resources: \[(.*?)\][\s\S]*?verbs: \[(.*?)\]/g)].map(
            (m) => ({
              apiGroups: m[1].split(',').map((s) => s.trim().replaceAll("'", '')),
              resources: m[2].split(',').map((s) => s.trim()),
              verbs: m[3].split(',').map((s) => s.trim()),
            }),
          ),
        }) satisfies ClusterRoleDoc,
    )
    .find((doc): doc is ClusterRoleDoc => doc.kind === 'ClusterRole' && doc.metadata.name === 'yaaabk-backend');
  expect(doc, 'yaaabk-backend ClusterRole not found in deploy/rbac.yaml').toBeDefined();
  return doc!.rules;
}

describe('deploy/rbac.yaml', () => {
  it('grants rolebindings in the rbac.authorization.k8s.io group', () => {
    const rule = clusterRoleRules().find((r) => r.resources.includes('rolebindings'));
    expect(rule).toBeDefined();
    expect(rule!.apiGroups).toContain('rbac.authorization.k8s.io');
    // RoleBindings in the core group were silently ignored by the API server,
    // so every Project failed at "Granting agent permissions" with a 403.
    expect(rule!.apiGroups).not.toContain('');
  });

  it('still covers the core-group resources the backend provisions', () => {
    const core = clusterRoleRules().find((r) => r.apiGroups.includes(''));
    expect(core?.resources).toEqual(
      expect.arrayContaining(['namespaces', 'secrets', 'serviceaccounts']),
    );
  });

  it('covers the ArgoCD and batch resources', () => {
    const rules = clusterRoleRules();
    const argo = rules.find((r) => r.apiGroups.includes('argoproj.io'));
    expect(argo?.resources).toContain('applications');
    // AppProjects are cluster-scoped and the per-Project ArgoCD step creates
    // one; without this the creation fails at "Configuring ArgoCD" with 403.
    expect(argo?.resources).toContain('appprojects');
    expect(rules.find((r) => r.apiGroups.includes('batch'))?.resources).toContain('jobs');
  });

  it('grants the backend the edit ClusterRole it delegates to agents', () => {
    const text = readFileSync(fileURLToPath(new URL('../deploy/rbac.yaml', import.meta.url)), 'utf8');
    const binding = text
      .split(/^---$/m)
      .map((part) => part.trim())
      .filter((part) => /^apiVersion:/m.test(part))
      .map((part) => ({
        kind: /^kind:\s*(\S+)/m.exec(part)?.[1] ?? '',
        name: /^metadata:\n\s+name:\s*(\S+)/m.exec(part)?.[1] ?? '',
        role: /kind: ClusterRole\n {2}name: (\S+)/.exec(part)?.[1] ?? '',
        subject: /^ {2}- kind: ServiceAccount\n {4}name: (\S+)$/m.exec(part)?.[1] ?? '',
      }))
      .find(
        (doc) =>
          doc.kind === 'ClusterRoleBinding' &&
          doc.role === 'edit' &&
          doc.subject === 'yaaabk-backend',
      );
    expect(binding, 'edit binding for yaaabk-backend not found').toBeDefined();
  });
});