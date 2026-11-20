import { normaliseGeneratedIssues, normaliseSummary } from '@yaaabk/shared';
import { ReportClientError, type ReportClient, type SessionStatus } from './client';

/** One JSON-RPC response the server writes back. */
export interface McpResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** One MCP tool description, as `tools/list` reports it. */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'report_prd',
    description:
      'Report the finished Plan for this agent session. YAAABK stores it as a draft and only publishes it when the Developer clicks Finish.',
    inputSchema: {
      type: 'object',
      properties: {
        prd: {
          type: 'string',
          description: 'The complete Plan as Markdown, following the YAAABK Plan template.',
        },
        summary: {
          type: 'string',
          maxLength: 200,
          description:
            'One or two plain-English sentences with no Markdown that say what the Plan delivers.',
        },
      },
      required: ['prd', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_issues',
    description:
      'Report the vertical-slice Issues for this agent session. YAAABK stores them as drafts and only publishes them when the Developer clicks Finish.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          description: 'The Issues, each cutting end to end through the application.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short, unique, imperative title.' },
              body: { type: 'string', description: 'What to build, as Markdown.' },
              summary: {
                type: 'string',
                maxLength: 200,
                description:
                  'One or two plain-English sentences with no Markdown that say what the Issue delivers.',
              },
              labels: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['ready', 'needs-human', 'blocked', 'refinement-needed'],
                },
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'Titles of Issues that must be implemented first.',
              },
            },
            required: ['title', 'summary'],
          },
        },
      },
      required: ['issues'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_status',
    description:
      'Read this agent session’s status and whether its Plan and Issues have been reported yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** A tool result in MCP's `content` shape. */
function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function messageOf(error: unknown): string {
  if (error instanceof ReportClientError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeDraft(status: SessionStatus): string {
  const prd = status.draft.hasPrd ? 'Plan reported' : 'Plan missing';
  return `${prd}, ${status.draft.issueCount} ${status.draft.issueCount === 1 ? 'issue' : 'issues'}`;
}

/** The JSON-RPC/MCP surface the reporting tools run behind. */
export interface ReportingServer {
  /** Handles one decoded JSON-RPC message; resolves `null` for notifications. */
  handle(message: unknown): Promise<McpResponse | null>;
  /** Parses and handles one newline-delimited JSON-RPC line. */
  handleLine(line: string): Promise<McpResponse | null>;
}

export interface ReportingServerOptions {
  client: ReportClient;
  version?: string;
}

/**
 * Builds the stdio MCP server a Grill-Me Session runs next to OpenCode.
 *
 * It exposes three tools and nothing else: two typed report calls and a status
 * read. Code Mode is disabled in the image's OpenCode configuration, so the
 * model calls these tools directly rather than through a JavaScript sandbox.
 */
export function createReportingServer(options: ReportingServerOptions): ReportingServer {
  const { client } = options;

  function respond(id: unknown, result: unknown): McpResponse {
    return { jsonrpc: '2.0', id, result };
  }

  function fail(id: unknown, code: number, message: string): McpResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  async function callTool(name: string, args: unknown): Promise<McpResponse> {
    if (name === 'report_prd') {
      const input = asObject(args);
      const prd = input?.['prd'];
      if (typeof prd !== 'string' || prd.trim() === '') {
        return respond(null, textResult('report_prd needs a non-empty `prd` string.', true));
      }
      const summary = normaliseSummary(input?.['summary']);
      if (!summary.ok) {
        return respond(
          null,
          textResult(`report_prd needs a valid \`summary\`: ${summary.message}.`, true),
        );
      }
      try {
        const status = await client.report({ prd: prd.trim(), summary: summary.value });
        const next =
          status.draft.issueCount === 0
            ? ' Now report the Issues with report_issues.'
            : ' Report the Issues again if they change.';
        return respond(
          null,
          textResult(
            `Plan draft stored for session ${status.id}; ${describeDraft(status)}.${next}`,
          ),
        );
      } catch (error) {
        return respond(null, textResult(`Could not store the Plan: ${messageOf(error)}`, true));
      }
    }

    if (name === 'report_issues') {
      const input = asObject(args);
      const normalised = normaliseGeneratedIssues(input?.['issues']);
      if (!normalised.ok) {
        return respond(null, textResult(`report_issues was rejected: ${normalised.message}`, true));
      }
      if (normalised.value.length === 0) {
        return respond(null, textResult('report_issues needs at least one issue.', true));
      }
      const relabelled =
        normalised.relabelled.length === 0
          ? ''
          : ` Relabelled as needs-human, because the acceptance check is not executable: ${normalised.relabelled.map((title) => `"${title}"`).join(', ')}. Add a runnable command and its expected result to keep an Issue ready.`;
      try {
        const status = await client.report({ issues: normalised.value });
        return respond(
          null,
          textResult(
            `${normalised.value.length} issue ${normalised.value.length === 1 ? 'draft' : 'drafts'} stored for session ${status.id}; ${describeDraft(status)}.${relabelled}`,
          ),
        );
      } catch (error) {
        return respond(null, textResult(`Could not store the issues: ${messageOf(error)}`, true));
      }
    }

    if (name === 'session_status') {
      try {
        const status = await client.status();
        return respond(
          null,
          textResult(`Session ${status.id} is ${status.status}; ${describeDraft(status)}.`),
        );
      } catch (error) {
        return respond(null, textResult(`Could not read the status: ${messageOf(error)}`, true));
      }
    }

    // A tool call needs a request id to answer; the router passes it separately.
    return respond(null, textResult(`Unknown tool "${name}".`, true));
  }

  async function handle(message: unknown): Promise<McpResponse | null> {
    const request = asObject(message);
    if (request === undefined || request['jsonrpc'] !== '2.0') {
      return fail(null, -32600, 'Invalid JSON-RPC request');
    }
    const method = request['method'];
    if (typeof method !== 'string') {
      return fail(request['id'] ?? null, -32600, 'Invalid JSON-RPC request');
    }
    const id = request['id'];
    const isNotification = id === undefined;

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    if (method === 'initialize') {
      const params = asObject(request['params']);
      const requested = params?.['protocolVersion'];
      return respond(id ?? null, {
        protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'yaaabk-grill-reports',
          version: options.version ?? '1.0.0',
        },
      });
    }
    if (method === 'ping') {
      return isNotification ? null : respond(id ?? null, {});
    }
    if (method === 'tools/list') {
      return isNotification ? null : respond(id ?? null, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      if (isNotification) return null;
      const params = asObject(request['params']);
      const name = params?.['name'];
      if (typeof name !== 'string') {
        return fail(id ?? null, -32602, 'tools/call needs a tool name');
      }
      if (!TOOLS.some((tool) => tool.name === name)) {
        return fail(id ?? null, -32602, `Unknown tool "${name}"`);
      }
      // The tool result factory sets the request id, since it does not know it.
      const result = await callTool(name, params?.['arguments']);
      return { ...result, id: id ?? null };
    }
    return isNotification ? null : fail(id ?? null, -32601, `Unknown method "${method}"`);
  }

  return {
    handle,
    async handleLine(line) {
      const trimmed = line.trim();
      if (trimmed === '') return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return fail(null, -32700, 'Parse error');
      }
      return handle(parsed);
    },
  };
}
