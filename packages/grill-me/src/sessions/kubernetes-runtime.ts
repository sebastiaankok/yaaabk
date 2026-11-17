/**
 * The Kubernetes SessionRuntime adapter.
 *
 * One Grill-Me Session runs in one hardened Pod in the Project's Namespace.
 * The adapter owns everything cluster-specific: the Pod, its NetworkPolicy and
 * the short-lived Secrets that carry the clone token and session credentials.
 * It satisfies the same narrow port as the local adapter, so the orchestrator
 * and terminal proxy do not know which environment a session runs in.
 */

import { randomBytes } from 'node:crypto';
import type { K8sClient, PodSpec } from '@yaaabk/k8s';
import { isSkillLevel } from '@yaaabk/shared';
import {
  type SessionRuntime,
  type SessionRuntimeInspection,
  type SessionRuntimeRef,
  type SessionRuntimeSpec,
  type SessionTerminalEndpoint,
} from './runtime-types';

/** The Project's agent identity: read-only cluster access plus `pods/exec`. */
export const SESSION_SERVICE_ACCOUNT = 'yaaabk-agent';

/** The port ttyd listens on inside the session Pod. */
export const SESSION_TTYD_PORT = 7681;

/** Where the clone init container and the agent share the cloned repository. */
export const SESSION_WORKSPACE_PATH = '/workspace';
export const SESSION_REPO_PATH = `${SESSION_WORKSPACE_PATH}/repo`;

const LABEL_SESSION = 'yaaabk.io/session-id';
const LABEL_PROJECT = 'yaaabk.io/project-id';
const LABEL_PROJECT_NAME = 'yaaabk.io/project-name';
const LABEL_APP = 'app.kubernetes.io/name';
const SESSION_APP = 'yaaabk-session';
const MAX_POD_NAME = 63;

export interface KubernetesSessionRuntimeOptions {
  /** The high-level K8s client. Tests inject one backed by an in-memory cluster. */
  k8s: K8sClient;
  /** The shared agent image: OpenCode, ttyd, git, kubectl and the grill skills. */
  image: string;
  /** Namespace the backend runs in; session ingress and egress allow it. */
  backendNamespace?: string;
  /** Pod label selecting the backend, so only its proxy may reach the terminal. */
  backendPodSelector?: Record<string, string>;
  /** ServiceAccount the Pod runs as. Defaults to `yaaabk-agent`. */
  serviceAccountName?: string;
  /** ttyd executable inside the image. Defaults to `ttyd`. */
  ttydCommand?: string;
  /** OpenCode executable inside the image. Defaults to `opencode`. */
  opencodeCommand?: string;
  /** OpenCode config loaded from the image. Defaults to `/app/opencode-session.json`. */
  opencodeConfig?: string;
  /** How long start waits for the Pod and ttyd. Defaults to 120 seconds. */
  readinessTimeoutMs?: number;
  /** Pause between readiness checks. Defaults to 1 second. */
  readinessPollMs?: number;
  /** Sleep implementation. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock used for readiness deadlines. Defaults to the wall clock. */
  now?: () => Date;
  /** Checks whether ttyd behind the Pod IP is accepting connections. */
  probe?: (endpoint: SessionTerminalEndpoint) => Promise<boolean>;
  /** Generates the ttyd credential. Defaults to a random 32-byte token. */
  credential?: () => { username: string; token: string };
  /** Creates the Pod's request/limit envelope. */
  resources?: { requests: Record<string, string>; limits: Record<string, string> };
  logger?: { info(message: string, fields?: Record<string, unknown>): void };
}

interface RuntimeRecord {
  ref: SessionRuntimeRef;
  namespace: string;
  podName: string;
  policyName: string;
  cloneSecret: string | null;
  sessionSecret: string | null;
  state: 'starting' | 'ready' | 'failed' | 'stopped';
  reason?: string;
}

const LOOPBACK = '0.0.0.0';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialHeader(endpoint: SessionTerminalEndpoint): Record<string, string> {
  if (endpoint.credential === undefined) return {};
  const raw = `${endpoint.credential.username}:${endpoint.credential.token}`;
  return { authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
}

async function probeTtyd(endpoint: SessionTerminalEndpoint): Promise<boolean> {
  const httpUrl = endpoint.url.replace(/^ws/, 'http').replace(/\/ws$/, '/');
  try {
    const response = await fetch(httpUrl, {
      headers: credentialHeader(endpoint),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** A DNS-1123 Pod name derived from the session id. */
export function sessionPodName(sessionId: string): string {
  const cleaned = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_POD_NAME - 'grill-'.length);
  return `grill-${cleaned === '' ? 'session' : cleaned}`;
}

/** The repository must be a plain `owner/name`, never shell metacharacters. */
function validRepoFullName(value: string | undefined): value is string {
  if (value === undefined) return false;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validSpec(spec: SessionRuntimeSpec): string | undefined {
  if (typeof spec.sessionId !== 'string' || spec.sessionId.trim() === '') {
    return 'A session id is required';
  }
  if (typeof spec.projectId !== 'string' || spec.projectId.trim() === '') {
    return 'A project id is required';
  }
  if (typeof spec.projectName !== 'string' || spec.projectName.trim() === '') {
    return 'A project name is required';
  }
  if (typeof spec.namespace !== 'string' || spec.namespace.trim() === '') {
    return 'A project namespace is required';
  }
  if (!validRepoFullName(spec.repoFullName)) {
    return 'A repository in owner/name form is required';
  }
  if (typeof spec.idea !== 'string' || spec.idea.trim() === '') {
    return 'An idea is required';
  }
  if (!isSkillLevel(spec.skillLevel)) {
    return `"${String(spec.skillLevel)}" is not a valid skill level`;
  }
  if (typeof spec.prompt !== 'string' || spec.prompt.trim() === '') {
    return 'An opening prompt is required';
  }
  if (typeof spec.model !== 'string' || spec.model.trim() === '') {
    return 'A model is required';
  }
  return undefined;
}

function sessionLabels(spec: SessionRuntimeSpec): Record<string, string> {
  return {
    [LABEL_APP]: SESSION_APP,
    [LABEL_SESSION]: spec.sessionId,
    [LABEL_PROJECT]: spec.projectId,
  };
}

/** The shell script that clones with the token and leaves a credential-free remote. */
function cloneScript(repoFullName: string): string {
  return [
    'set -eu',
    `git clone --depth 1 "https://x-access-token:\${GITHUB_TOKEN}@github.com/${repoFullName}.git" ${SESSION_REPO_PATH}`,
    `git -C ${SESSION_REPO_PATH} remote set-url origin "https://github.com/${repoFullName}.git"`,
    'unset GITHUB_TOKEN',
  ].join('\n');
}

function restrictedContainer(name: string): Record<string, unknown> {
  return {
    name,
    allowPrivilegeEscalation: false,
    runAsNonRoot: true,
    capabilities: { drop: ['ALL'] },
  };
}

/** The Pod manifest for one session. */
function sessionPodSpec(
  spec: SessionRuntimeSpec,
  options: Required<Pick<KubernetesSessionRuntimeOptions, 'image' | 'serviceAccountName'>> &
    Pick<
      KubernetesSessionRuntimeOptions,
      'ttydCommand' | 'opencodeCommand' | 'opencodeConfig' | 'resources'
    >,
  credential: { username: string; token: string },
  cloneSecret: string | null,
  sessionSecret: string | null,
): PodSpec {
  const labels = sessionLabels(spec);

  const cloneContainer =
    cloneSecret === null || spec.repoFullName === undefined
      ? []
      : [
          {
            name: 'clone',
            image: options.image,
            command: ['sh', '-c', cloneScript(spec.repoFullName)],
            env: { REPO_FULL_NAME: spec.repoFullName },
            envFrom: [{ secretRef: { name: cloneSecret } }],
            volumeMounts: [{ name: 'workspace', mountPath: SESSION_WORKSPACE_PATH }],
            securityContext: restrictedContainer('clone'),
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
          },
        ];

  return {
    serviceAccountName: options.serviceAccountName,
    labels,
    restartPolicy: 'Never',
    volumes: [{ name: 'workspace', emptyDir: {} }],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    initContainers: cloneContainer,
    containers: [
      {
        name: 'session',
        image: options.image,
        command: [options.ttydCommand ?? 'ttyd'],
        args: [
          '--port',
          String(SESSION_TTYD_PORT),
          '--interface',
          LOOPBACK,
          '--writable',
          '--credential',
          `${credential.username}:${credential.token}`,
          options.opencodeCommand ?? 'opencode',
          'mini',
          '--session',
          spec.sessionId,
          '--prompt',
          spec.prompt,
          '--model',
          spec.model,
          '--replay',
          '--standalone',
        ],
        workingDir: SESSION_REPO_PATH,
        env: {
          YAAABK_PROJECT_ID: spec.projectId,
          YAAABK_SESSION_ID: spec.sessionId,
          YAAABK_SKILL_LEVEL: spec.skillLevel,
          ...(spec.apiUrl === undefined ? {} : { YAAABK_API_URL: spec.apiUrl }),
          ...(options.opencodeConfig === undefined
            ? {}
            : { OPENCODE_CONFIG: options.opencodeConfig }),
          HOME: '/home/bun',
        },
        envFrom: sessionSecret === null ? undefined : [{ secretRef: { name: sessionSecret } }],
        volumeMounts: [{ name: 'workspace', mountPath: SESSION_WORKSPACE_PATH }],
        securityContext: restrictedContainer('session'),
        resources: options.resources ?? {
          requests: { cpu: '250m', memory: '256Mi' },
          limits: { cpu: '1', memory: '1Gi' },
        },
      },
    ],
  };
}

/**
 * Builds the NetworkPolicy that keeps a session's terminal private and its
 * egress to the backend, the API server, GitHub/OpenRouter HTTPS and DNS.
 */
function sessionNetworkPolicy(
  spec: SessionRuntimeSpec,
  options: {
    backendNamespace: string;
    backendPodSelector: Record<string, string>;
  },
) {
  const backend = {
    namespaceSelector: {
      matchLabels: { 'kubernetes.io/metadata.name': options.backendNamespace },
    },
    podSelector: { matchLabels: options.backendPodSelector },
  };
  return {
    podSelector: { matchLabels: { [LABEL_SESSION]: spec.sessionId } },
    labels: sessionLabels(spec),
    policyTypes: ['Ingress', 'Egress'] as Array<'Ingress' | 'Egress'>,
    ingress: [
      {
        from: [backend],
        ports: [{ protocol: 'TCP' as const, port: SESSION_TTYD_PORT }],
      },
    ],
    egress: [
      {
        // The reporting MCP server posts drafts to the backend.
        to: [backend],
      },
      {
        // DNS.
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
            },
          },
        ],
        ports: [
          { protocol: 'UDP' as const, port: 53 },
          { protocol: 'TCP' as const, port: 53 },
        ],
      },
      {
        // GitHub, OpenRouter and the Kubernetes API over HTTPS. The peer is
        // deliberately omitted (all destinations) for two reasons: NetworkPolicy
        // cannot name hosts, and kube-proxy DNATs the `kubernetes` Service IP to
        // a control-plane node before egress policy is evaluated, so neither
        // the Service ClusterIP nor an `ipBlock` peer matches the API. Port 6443
        // is the API server's usual port; 443 covers distributions that front it
        // with a TLS proxy.
        ports: [
          { protocol: 'TCP' as const, port: 443 },
          { protocol: 'TCP' as const, port: 6443 },
        ],
      },
    ],
  };
}

/**
 * Runs sessions as hardened Pods in the Project's Namespace.
 */
export function createKubernetesSessionRuntime(
  options: KubernetesSessionRuntimeOptions,
): SessionRuntime {
  const backendNamespace = options.backendNamespace ?? 'yaaabk';
  const backendPodSelector = options.backendPodSelector ?? {
    'app.kubernetes.io/name': 'yaaabk-backend',
  };
  const serviceAccountName = options.serviceAccountName ?? SESSION_SERVICE_ACCOUNT;
  const ttydCommand = options.ttydCommand ?? 'ttyd';
  const opencodeCommand = options.opencodeCommand ?? 'opencode';
  const opencodeConfig =
    options.opencodeConfig ??
    process.env['YAAABK_SESSION_OPENCODE_CONFIG'] ??
    '/app/opencode-session.json';
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
  const readinessPollMs = options.readinessPollMs ?? 1_000;
  const sleep = options.sleep ?? sleepFor;
  const now = options.now ?? (() => new Date());
  const probe = options.probe ?? probeTtyd;
  const credential =
    options.credential ?? (() => ({ username: 'yaaabk', token: randomBytes(32).toString('hex') }));
  const logger = options.logger ?? { info: () => {} };
  const records = new Map<string, RuntimeRecord>();

  const podOptions = {
    image: options.image,
    serviceAccountName,
    ttydCommand,
    opencodeCommand,
    ...(opencodeConfig === undefined ? {} : { opencodeConfig }),
    ...(options.resources === undefined ? {} : { resources: options.resources }),
  };

  /** Best-effort removal of everything a session created. */
  async function cleanup(record: {
    namespace: string;
    podName: string;
    policyName: string;
    cloneSecret: string | null;
    sessionSecret: string | null;
  }): Promise<void> {
    const namespace = record.namespace;
    const removals: Array<Promise<unknown>> = [
      options.k8s.pods.delete(namespace, record.podName),
      options.k8s.networkPolicies.delete(namespace, record.policyName),
    ];
    if (record.sessionSecret !== null) {
      removals.push(options.k8s.secrets.delete(namespace, record.sessionSecret));
    }
    if (record.cloneSecret !== null) {
      removals.push(options.k8s.secrets.delete(namespace, record.cloneSecret));
    }
    const results = await Promise.allSettled(removals);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.info('session runtime cleanup failed', {
          namespace,
          sessionId: record.podName,
          message: messageOf(result.reason),
        });
        continue;
      }
      const value = result.value as { ok: boolean; error?: { kind: string; message: string } };
      if (!value.ok && value.error !== undefined && value.error.kind !== 'not-found') {
        logger.info('session runtime cleanup failed', {
          namespace,
          sessionId: record.podName,
          message: value.error.message,
        });
      }
    }
  }

  /** Rebuilds what stop/inspect need from a ref persisted by a previous process. */
  function recordFromRef(ref: SessionRuntimeRef): RuntimeRecord | undefined {
    if (ref.namespace === undefined) return undefined;
    const podName = ref.handle;
    return {
      ref,
      namespace: ref.namespace,
      podName,
      policyName: podName,
      cloneSecret: `${podName}-clone`,
      sessionSecret: `${podName}-session`,
      state: 'starting',
    };
  }

  return {
    async start(spec) {
      const invalid = validSpec(spec);
      if (invalid !== undefined) {
        return {
          ok: false,
          error: { kind: 'invalid-input', operation: 'start', message: invalid },
        };
      }
      if (records.has(spec.sessionId)) {
        return {
          ok: false,
          error: {
            kind: 'invalid-input',
            operation: 'start',
            message: `A runtime already exists for session "${spec.sessionId}"`,
          },
        };
      }

      const namespace = spec.namespace!;
      const podName = sessionPodName(spec.sessionId);
      const policyName = podName;
      const cloneSecret = spec.gitToken === undefined ? null : `${podName}-clone`;
      const wantsSessionSecret = spec.openRouterKey !== undefined || spec.reportToken !== undefined;
      const sessionSecretName = `${podName}-session`;
      const ttydCredential = credential();
      const terminal: SessionTerminalEndpoint = {
        url: `ws://127.0.0.1:${SESSION_TTYD_PORT}/ws`,
        credential: ttydCredential,
      };
      const created = {
        namespace,
        podName,
        policyName,
        cloneSecret,
        sessionSecret: wantsSessionSecret ? sessionSecretName : null,
      };

      try {
        const policy = await options.k8s.networkPolicies.create(
          namespace,
          policyName,
          sessionNetworkPolicy(spec, {
            backendNamespace,
            backendPodSelector,
          }),
        );
        if (!policy.ok) throw new Error(`NetworkPolicy: ${policy.error.message}`);

        if (cloneSecret !== null && spec.gitToken !== undefined) {
          const secret = await options.k8s.secrets.create(namespace, cloneSecret, {
            GITHUB_TOKEN: spec.gitToken,
          });
          if (!secret.ok) throw new Error(`clone Secret: ${secret.error.message}`);
        }

        const sessionData: Record<string, string> = {};
        if (spec.openRouterKey !== undefined) sessionData.OPENROUTER_API_KEY = spec.openRouterKey;
        if (spec.reportToken !== undefined) sessionData.YAAABK_REPORT_TOKEN = spec.reportToken;
        if (wantsSessionSecret) {
          const secret = await options.k8s.secrets.create(
            namespace,
            sessionSecretName,
            sessionData,
          );
          if (!secret.ok) throw new Error(`session Secret: ${secret.error.message}`);
        }

        const pod = await options.k8s.pods.create(
          namespace,
          podName,
          sessionPodSpec(
            spec,
            podOptions,
            ttydCredential,
            cloneSecret,
            wantsSessionSecret ? sessionSecretName : null,
          ),
        );
        if (!pod.ok) throw new Error(`Pod: ${pod.error.message}`);
      } catch (error) {
        await cleanup(created);
        return {
          ok: false,
          error: {
            kind: 'start-failed',
            operation: 'start',
            message: `Could not start the session Pod: ${messageOf(error)}`,
          },
        };
      }

      const ref: SessionRuntimeRef = {
        sessionId: spec.sessionId,
        projectId: spec.projectId,
        provider: 'kubernetes',
        handle: podName,
        namespace,
        terminal,
      };
      const record: RuntimeRecord = {
        ref,
        ...created,
        state: 'starting',
      };
      records.set(spec.sessionId, record);

      const deadline = now().getTime() + readinessTimeoutMs;
      let lastReason: string | undefined;
      for (;;) {
        const inspected = await options.k8s.pods.get(namespace, podName);
        if (!inspected.ok) {
          lastReason = inspected.error.message;
          break;
        }
        const pod = inspected.value;
        if (pod.phase === 'failed') {
          lastReason = pod.waitingReason ?? `Pod "${podName}" failed`;
          break;
        }
        if (pod.waitingReason !== null) lastReason = pod.waitingReason;
        if (pod.ready && pod.podIP !== null) {
          const endpoint: SessionTerminalEndpoint = {
            url: `ws://${pod.podIP}:${SESSION_TTYD_PORT}/ws`,
            credential: ttydCredential,
          };
          if (await probe(endpoint)) {
            record.state = 'ready';
            ref.terminal = endpoint;
            logger.info('kubernetes session runtime ready', {
              sessionId: spec.sessionId,
              namespace,
              pod: podName,
            });
            return { ok: true, value: ref };
          }
        }
        if (now().getTime() >= deadline) {
          lastReason = lastReason ?? `ttyd did not become ready within ${readinessTimeoutMs} ms`;
          break;
        }
        await sleep(readinessPollMs);
      }

      record.state = 'failed';
      record.reason = lastReason ?? 'The session Pod did not become ready';
      await cleanup(record);
      return {
        ok: false,
        error: {
          kind: 'start-failed',
          operation: 'start',
          message: record.reason,
        },
      };
    },

    async stop(ref) {
      const record = records.get(ref.sessionId) ?? recordFromRef(ref);
      if (record === undefined) {
        return {
          ok: false,
          error: {
            kind: 'not-found',
            operation: 'stop',
            message: `No Kubernetes runtime for session "${ref.sessionId}"`,
          },
        };
      }
      if (record.state === 'stopped') return { ok: true, value: undefined };
      record.state = 'stopped';
      await cleanup(record);
      return { ok: true, value: undefined };
    },

    async inspect(ref) {
      const record = records.get(ref.sessionId) ?? recordFromRef(ref);
      if (record === undefined) {
        return {
          ok: false,
          error: {
            kind: 'not-found',
            operation: 'inspect',
            message: `No Kubernetes runtime for session "${ref.sessionId}"`,
          },
        };
      }
      if (record.state === 'stopped') {
        return {
          ok: true,
          value: { state: 'stopped', ready: false, terminal: record.ref.terminal },
        };
      }

      const pod = await options.k8s.pods.get(record.namespace, record.podName);
      if (!pod.ok) {
        record.state = 'failed';
        record.reason = `Pod "${record.podName}": ${pod.error.message}`;
        return {
          ok: true,
          value: {
            state: 'failed',
            ready: false,
            reason: record.reason,
            terminal: record.ref.terminal,
          },
        };
      }
      // A reconstructed ref is only valid when the Pod belongs to that session;
      // otherwise the caller is inspecting a runtime this adapter never owned.
      if (pod.value.labels[LABEL_SESSION] !== ref.sessionId) {
        return {
          ok: false,
          error: {
            kind: 'not-found',
            operation: 'inspect',
            message: `No Kubernetes runtime for session "${ref.sessionId}"`,
          },
        };
      }
      if (pod.value.ready && pod.value.podIP !== null) {
        // A restarted backend reconnects to the Pod's current IP; the ttyd
        // credential from the persisted ref is still the one the Pod requires.
        record.ref.terminal = {
          url: `ws://${pod.value.podIP}:${SESSION_TTYD_PORT}/ws`,
          ...(record.ref.terminal.credential === undefined
            ? {}
            : { credential: record.ref.terminal.credential }),
        };
      }
      const inspection: SessionRuntimeInspection = {
        state: pod.value.ready ? 'ready' : pod.value.phase === 'failed' ? 'failed' : 'starting',
        ready: pod.value.ready,
        terminal: record.ref.terminal,
        ...(pod.value.waitingReason === null ? {} : { reason: pod.value.waitingReason }),
      };
      return { ok: true, value: inspection };
    },

    async list(filter = {}) {
      const refs = new Map<string, SessionRuntimeRef>();
      for (const record of records.values()) {
        if (record.state !== 'stopped') refs.set(record.ref.sessionId, record.ref);
      }

      // A restarted backend has no in-memory records; discover the Pods it left
      // behind in the Project Namespaces so reconciliation can stop them.
      const namespaces = await options.k8s.namespaces.list();
      if (namespaces.ok) {
        for (const namespace of namespaces.value) {
          if (namespace.labels[LABEL_PROJECT_NAME] === undefined) continue;
          const pods = await options.k8s.pods.list(namespace.name, { [LABEL_APP]: SESSION_APP });
          if (!pods.ok) continue;
          for (const pod of pods.value) {
            const sessionId = pod.labels[LABEL_SESSION];
            const projectId = pod.labels[LABEL_PROJECT];
            if (sessionId === undefined || projectId === undefined) continue;
            const known = refs.get(sessionId);
            if (known !== undefined) {
              if (pod.podIP !== null) {
                known.terminal = {
                  url: `ws://${pod.podIP}:${SESSION_TTYD_PORT}/ws`,
                  ...(known.terminal.credential === undefined
                    ? {}
                    : { credential: known.terminal.credential }),
                };
              }
              continue;
            }
            refs.set(sessionId, {
              sessionId,
              projectId,
              provider: 'kubernetes',
              handle: pod.name,
              namespace: namespace.name,
              terminal: {
                url: pod.podIP === null ? '' : `ws://${pod.podIP}:${SESSION_TTYD_PORT}/ws`,
              },
            });
          }
        }
      } else {
        logger.info('session runtime namespace discovery failed', {
          kind: namespaces.error.kind,
          message: namespaces.error.message,
        });
      }

      return {
        ok: true,
        value: [...refs.values()].filter(
          (ref) => filter.projectId === undefined || ref.projectId === filter.projectId,
        ),
      };
    },
  };
}
