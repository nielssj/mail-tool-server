import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { MailboxService } from '../src/services/mailboxService.js';
import { createAccountService } from '../src/services/accountService.js';
import type { AccountConfig } from '../src/utils/config/schema.js';

const ACCOUNTS: AccountConfig[] = [
  {
    id: 'acc-1',
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'user@example.com', pass: 'secret' },
    watchMailboxes: ['INBOX'],
    dispatchers: []
  }
];

const makeMailboxService = (): MailboxService => ({
  listMailboxes: async () => [],
  listMessages: async () => [],
  getMessage: async () => false,
  getAttachment: async () => false,
  getRawSource: async () => false,
  moveMessage: async () => false,
  setFlags: async () => undefined,
  createDraft: async () => ({ mailbox: 'Drafts' })
});

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };

describe('observeMcpTransportMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  /**
   * Fresh MeterProvider + fresh module graph per test — same ordering
   * constraint as the other telemetry decorator tests (instruments.ts
   * binds its Meter at module-load time).
   */
  const loadModules = async (): Promise<{
    createMcpHttpServer: typeof import('../src/mcp/httpServer.js')['createMcpHttpServer'];
    observeMcpTransportMetrics: typeof import('../src/telemetry/mcpTransportMetrics.js')['observeMcpTransportMetrics'];
  }> => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const [{ createMcpHttpServer }, { observeMcpTransportMetrics }] = await Promise.all([
      import('../src/mcp/httpServer.js'),
      import('../src/telemetry/mcpTransportMetrics.js')
    ]);
    return { createMcpHttpServer, observeMcpTransportMetrics };
  };

  const histogramPoints = async (): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, 'mailtool.mcp.request.duration');
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  it('records outcome "ok" for a successful POST /mcp request', async () => {
    const { createMcpHttpServer, observeMcpTransportMetrics } = await loadModules();
    const server = createMcpHttpServer({
      mailboxService: makeMailboxService(),
      accountService: createAccountService(ACCOUNTS)
    });
    observeMcpTransportMetrics(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/mcp`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' }
          }
        })
      });

      const points = await histogramPoints();
      expect(points).toHaveLength(1);
      expect(points[0]!.attributes).toMatchObject({ outcome: 'ok' });
      expect(points[0]!.value.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('records outcome "error" for a transport-level failure (e.g. wrong method)', async () => {
    const { createMcpHttpServer, observeMcpTransportMetrics } = await loadModules();
    const server = createMcpHttpServer({
      mailboxService: makeMailboxService(),
      accountService: createAccountService(ACCOUNTS)
    });
    observeMcpTransportMetrics(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/mcp`;

    try {
      const response = await fetch(url, { method: 'GET' });
      expect(response.status).toBe(405);

      const points = await histogramPoints();
      expect(points).toHaveLength(1);
      expect(points[0]!.attributes).toMatchObject({ outcome: 'error' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
