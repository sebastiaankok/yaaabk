#!/usr/bin/env bun
/**
 * End-to-end smoke check for the scaffolded app.
 *
 * Starts the real server entry point on an ephemeral port, waits for `/health`,
 * checks the health, hello and SPA root responses, and always stops the process
 * again. Exits non-zero on any failure, so `bun run smoke` is safe to use in CI
 * and in an Agent run.
 *
 * The SPA root is served from `web/build`, which `bun run build` creates. Run
 * `bun run check` (which builds first) or `bun run build` before this script.
 */

import { createServer } from 'node:net';
import { join } from 'node:path';

/** How long the server may take to start answering requests. */
const READY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

const root = join(import.meta.dir, '..');

/** Binds port 0 to let the OS pick a free port, then releases it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Polls `/health` until the server answers or the timeout expires. */
async function waitForHealth(baseUrl: string, exited: () => number | null): Promise<Response> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const exitCode = exited();
    if (exitCode !== null) {
      throw new Error(`the server exited with code ${exitCode} before answering /health`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response;
    } catch {
      // Not listening yet; retry until the deadline.
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`the server did not answer /health within ${READY_TIMEOUT_MS / 1000}s`);
}

async function main(): Promise<void> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = Bun.spawn([process.execPath, 'server/src/index.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(server.stdout).text();
  const stderr = new Response(server.stderr).text();

  let failure: unknown;
  try {
    const health = await waitForHealth(baseUrl, () => server.exitCode);
    const healthBody = (await health.json()) as { status?: unknown };
    if (healthBody.status !== 'ok') {
      throw new Error(`/health returned ${JSON.stringify(healthBody)}, expected {"status":"ok"}`);
    }

    const hello = await fetch(`${baseUrl}/api/hello`);
    if (!hello.ok) {
      throw new Error(`/api/hello returned HTTP ${hello.status}`);
    }
    const helloBody = (await hello.json()) as { message?: unknown };
    if (typeof helloBody.message !== 'string' || helloBody.message.trim() === '') {
      throw new Error(`/api/hello returned ${JSON.stringify(helloBody)}, expected a message`);
    }

    const page = await fetch(baseUrl);
    if (!page.ok) {
      throw new Error(`/ returned HTTP ${page.status}; run \`bun run build\` so web/build exists`);
    }
    const contentType = page.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      throw new Error(`/ returned content-type ${contentType || '(none)'}, expected text/html`);
    }
    const html = await page.text();
    if (!html.toLowerCase().includes('<!doctype html')) {
      throw new Error('/ did not return the SPA shell');
    }

    console.log(`smoke: /health, /api/hello and / answered on ${baseUrl}`);
  } catch (error) {
    failure = error;
  } finally {
    server.kill();
    await server.exited;
  }

  const [out, err] = await Promise.all([stdout, stderr]);
  if (failure !== undefined) {
    console.error(`smoke: ${failure instanceof Error ? failure.message : String(failure)}`);
    if (out.trim() !== '') console.error(out.trim());
    if (err.trim() !== '') console.error(err.trim());
    process.exit(1);
  }
}

await main();
