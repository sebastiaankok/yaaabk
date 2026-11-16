import type { GeneratedIssueReport } from '@yaaabk/shared';

/** What the MCP server can report about its session. */
export interface SessionStatus {
  id: string;
  status: string;
  draft: { hasPrd: boolean; issueCount: number };
}

/** The HTTP calls the reporting tools make. Tests inject a fake. */
export interface ReportClient {
  /** Stores the PRD and/or issue list as drafts on the session. */
  report(report: { prd?: string; issues?: GeneratedIssueReport[] }): Promise<SessionStatus>;
  /** Reads the session's current status and draft counts. */
  status(): Promise<SessionStatus>;
}

/** A failed report call with a message an agent can act on. */
export class ReportClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ReportClientError';
  }
}

export interface ReportClientOptions {
  /** Backend base URL, e.g. `http://backend:3000`. */
  apiUrl: string;
  sessionId: string;
  token: string;
  /** Test seam. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

function sessionUrl(apiUrl: string, sessionId: string, suffix: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/api/grill-sessions/${encodeURIComponent(sessionId)}/${suffix}`;
}

/** Parses a session-status response, rejecting anything that is not one. */
function asStatus(value: unknown, status: number): SessionStatus {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const draft = record['draft'];
    if (typeof record['id'] === 'string' && typeof draft === 'object' && draft !== null) {
      const counts = draft as Record<string, unknown>;
      return {
        id: record['id'],
        status: typeof record['status'] === 'string' ? record['status'] : 'unknown',
        draft: {
          hasPrd: counts['hasPrd'] === true,
          issueCount: typeof counts['issueCount'] === 'number' ? counts['issueCount'] : 0,
        },
      };
    }
  }
  throw new ReportClientError('The backend returned an unexpected session status', status);
}

/** Reads the error message the backend reported, when it sent one. */
async function failureOf(response: Response): Promise<ReportClientError> {
  let message = `The backend rejected the report with status ${response.status}`;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body['message'] === 'string' && body['message'] !== '') {
      message = body['message'];
    }
  } catch {
    // Keep the status-based message.
  }
  return new ReportClientError(message, response.status);
}

/**
 * Builds the HTTP client behind the reporting tools.
 *
 * Every call carries the session's bearer token; the backend resolves the
 * session from it, so the agent never sees the Developer's cookie.
 */
export function createReportClient(options: ReportClientOptions): ReportClient {
  const doFetch = options.fetch ?? fetch;

  async function call(suffix: string, init: RequestInit): Promise<SessionStatus> {
    const response = await doFetch(sessionUrl(options.apiUrl, options.sessionId, suffix), {
      ...init,
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
    });
    if (!response.ok) throw await failureOf(response);
    return asStatus(await response.json(), response.status);
  }

  return {
    report(report) {
      return call('report', { method: 'POST', body: JSON.stringify(report) });
    },
    status() {
      return call('status', { method: 'GET' });
    },
  };
}
