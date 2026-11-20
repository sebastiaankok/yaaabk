import type { GeneratedIssueReport } from '@yaaabk/shared';
import { describe, expect, it } from 'vitest';
import { ReportClientError, type ReportClient, type SessionStatus } from './client';
import { createReportingServer } from './server';

const STATUS: SessionStatus = {
  id: 'session-1',
  status: 'active',
  draft: { hasPrd: false, issueCount: 0 },
};

interface RecordedReport {
  prd?: string;
  summary?: string;
  issues?: GeneratedIssueReport[];
}

function fakeClient(overrides: Partial<ReportClient> = {}): {
  client: ReportClient;
  readonly reports: RecordedReport[];
  readonly statusCalls: number;
} {
  const reports: RecordedReport[] = [];
  let statusCalls = 0;
  const client: ReportClient = {
    async report(report) {
      reports.push(report);
      return {
        ...STATUS,
        draft: {
          hasPrd: report.prd !== undefined || STATUS.draft.hasPrd,
          issueCount: report.issues?.length ?? STATUS.draft.issueCount,
        },
      };
    },
    async status() {
      statusCalls += 1;
      return STATUS;
    },
    ...overrides,
  };
  return {
    client,
    reports,
    get statusCalls() {
      return statusCalls;
    },
  };
}

function setup(overrides: Partial<ReportClient> = {}) {
  const fake = fakeClient(overrides);
  return { ...fake, server: createReportingServer({ client: fake.client }) };
}

function call(id: number, name: string, args: unknown) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

interface TextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

describe('MCP handshake', () => {
  it('answers initialize with tool capabilities', async () => {
    const { server } = setup();

    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'yaaabk-grill-reports' },
      },
    });
  });

  it('does not reply to the initialized notification', async () => {
    const { server } = setup();

    await expect(
      server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).resolves.toBeNull();
  });

  it('lists the three reporting tools', async () => {
    const { server } = setup();

    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const result = response?.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'report_prd',
      'report_issues',
      'session_status',
    ]);
  });
});

describe('reporting tools', () => {
  it('stores a Plan and confirms it is only a draft', async () => {
    const { server, reports } = setup();

    const response = await server.handle(
      call(3, 'report_prd', { prd: '# Plan', summary: 'Plan for saving bookmarks.' }),
    );

    const result = response?.result as TextResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Plan draft stored');
    expect(result.content[0]?.text).not.toContain('PRD');
    expect(reports).toEqual([{ prd: '# Plan', summary: 'Plan for saving bookmarks.' }]);
  });

  it('rejects a Plan without a valid summary', async () => {
    const { server, reports } = setup();

    const missing = await server.handle(call(4, 'report_prd', { prd: '# Plan' }));
    const empty = await server.handle(call(5, 'report_prd', { prd: '# Plan', summary: '   ' }));
    const tooLong = await server.handle(
      call(6, 'report_prd', { prd: '# Plan', summary: 'x'.repeat(201) }),
    );

    for (const response of [missing, empty, tooLong]) {
      const result = response?.result as TextResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('summary');
    }
    expect(reports).toEqual([]);
  });

  it('rejects a malformed PRD without calling the backend', async () => {
    const { server, reports } = setup();

    const response = await server.handle(call(7, 'report_prd', { prd: '   ', summary: 'A plan.' }));

    const result = response?.result as TextResult;
    expect(result.isError).toBe(true);
    expect(reports).toEqual([]);
  });

  it('normalises and stores an issue list', async () => {
    const { server, reports } = setup();

    const response = await server.handle(
      call(8, 'report_issues', {
        issues: [
          {
            title: ' Save a bookmark ',
            summary: '  Save   a link for later. ',
            body: '## Acceptance criteria\n\n- [ ] `bun test` passes and reports the new test.',
            labels: ['ready'],
            depends_on: [],
          },
        ],
      }),
    );

    const result = response?.result as TextResult;
    expect(result.isError).toBeUndefined();
    expect(reports).toEqual([
      {
        issues: [
          {
            title: 'Save a bookmark',
            body: '## Acceptance criteria\n\n- [ ] `bun test` passes and reports the new test.',
            summary: 'Save a link for later.',
            labels: ['ready'],
            depends_on: [],
          },
        ],
      },
    ]);
  });

  it('stores a ready issue with a visual acceptance check without relabelling it', async () => {
    const { server, reports } = setup();

    const response = await server.handle(
      call(15, 'report_issues', {
        issues: [
          {
            title: 'Centre the card',
            summary: 'Centre the card on the page.',
            body: '## Acceptance criteria\n\n- [ ] Open the page and confirm that the card is centred.',
            labels: ['ready'],
            depends_on: [],
          },
        ],
      }),
    );

    const result = response?.result as TextResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).not.toContain('needs-human');
    expect(reports).toEqual([
      {
        issues: [
          {
            title: 'Centre the card',
            body: '## Acceptance criteria\n\n- [ ] Open the page and confirm that the card is centred.',
            summary: 'Centre the card on the page.',
            labels: ['ready'],
            depends_on: [],
          },
        ],
      },
    ]);
  });

  it('rejects an issue without a summary', async () => {
    const { server, reports } = setup();

    const response = await server.handle(
      call(9, 'report_issues', { issues: [{ title: 'Save a bookmark' }] }),
    );

    const result = response?.result as TextResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('summary');
    expect(reports).toEqual([]);
  });

  it('rejects a malformed issue list without calling the backend', async () => {
    const { server, reports } = setup();

    const response = await server.handle(
      call(10, 'report_issues', {
        issues: [{ body: 'no title', summary: 'A summary.' }],
      }),
    );

    const result = response?.result as TextResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('title');
    expect(reports).toEqual([]);
  });

  it('reports the session status', async () => {
    const { server } = setup();

    const response = await server.handle(call(11, 'session_status', {}));

    const result = response?.result as TextResult;
    expect(result.content[0]?.text).toContain('0 issues');
  });

  it('surfaces a backend rejection as an actionable error', async () => {
    const { server } = setup({
      report: async () => {
        throw new ReportClientError('Report a PRD before its issues', 400);
      },
    });

    const response = await server.handle(
      call(12, 'report_issues', { issues: [{ title: 'Save a bookmark', summary: 'A summary.' }] }),
    );

    const result = response?.result as TextResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Report a PRD before its issues');
  });

  it('rejects an unknown tool and an unknown method', async () => {
    const { server } = setup();

    const tool = await server.handle(call(13, 'delete_everything', {}));
    const method = await server.handle({ jsonrpc: '2.0', id: 14, method: 'nope' });

    expect(tool?.error?.code).toBe(-32602);
    expect(method?.error?.code).toBe(-32601);
  });
});
