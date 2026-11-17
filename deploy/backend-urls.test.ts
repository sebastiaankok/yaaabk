import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The backend's own env points Agent Jobs and Grill-Me Sessions at the
 * cluster-internal Service. A ClusterIP only forwards the ports its Service
 * declares: any other port is silently dropped, so the caller hangs instead of
 * getting a connection refused. That is exactly how `report_prd` stalled for a
 * whole session when these URLs still said `:3000` while the Service only
 * published 80.
 */
const text = readFileSync(fileURLToPath(new URL('./backend.yaml', import.meta.url)), 'utf8');

function documents(): string[] {
  return text
    .split(/^---$/m)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Every port the Service publishes, ignoring its named target ports. */
function publishedPorts(): number[] {
  const service = documents().find((part) => /^kind:\s*Service$/m.test(part));
  expect(service, 'no Service document in deploy/backend.yaml').toBeDefined();
  return [...service!.matchAll(/^ {4}- name: \S+\n {6}port: (\d+)$/gm)].map((match) =>
    Number(match[1]),
  );
}

/** The cluster-internal URLs the backend hands to the workloads it starts. */
function inClusterUrls(): string[] {
  return [...text.matchAll(/value:\s*['"]?(http:\/\/[^\s'"]+)/g)]
    .map((match) => match[1])
    .filter((url) => new URL(url).hostname.endsWith('.svc.cluster.local'));
}

describe('deploy/backend.yaml', () => {
  it('publishes exactly one Service port', () => {
    expect(publishedPorts()).toEqual([80]);
  });

  it('points every cluster-internal URL at a port the Service publishes', () => {
    const urls = inClusterUrls();
    expect(urls.length, 'no cluster-internal URLs configured').toBeGreaterThan(0);
    const ports = publishedPorts();

    for (const url of urls) {
      const parsed = new URL(url);
      const port = parsed.port === '' ? 80 : Number(parsed.port);
      expect(ports, `${url} uses port ${port}, which the Service does not publish`).toContain(port);
    }
  });
});
