#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createReportClient } from './client';
import { createReportingServer } from './server';

/**
 * The stdio entrypoint OpenCode starts for a Grill-Me Session.
 *
 * The runtime injects the backend URL, session id and per-session report token
 * as environment variables. Nothing is read from disk and nothing is logged to
 * stdout, which carries the MCP protocol.
 */
function resolveEnvironment(env: NodeJS.ProcessEnv): {
  apiUrl: string;
  sessionId: string;
  token: string;
} {
  const apiUrl = env['YAAABK_API_URL'] ?? '';
  const sessionId = env['YAAABK_SESSION_ID'] ?? '';
  const token = env['YAAABK_REPORT_TOKEN'] ?? '';
  const missing = [
    apiUrl === '' ? 'YAAABK_API_URL' : '',
    sessionId === '' ? 'YAAABK_SESSION_ID' : '',
    token === '' ? 'YAAABK_REPORT_TOKEN' : '',
  ].filter((name) => name !== '');
  if (missing.length > 0) {
    throw new Error(`The reporting MCP server needs ${missing.join(', ')}`);
  }
  return { apiUrl, sessionId, token };
}

async function main(): Promise<void> {
  let environment: ReturnType<typeof resolveEnvironment>;
  try {
    environment = resolveEnvironment(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const client = createReportClient(environment);
  const server = createReportingServer({ client });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    const response = await server.handleLine(line);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

await main();
