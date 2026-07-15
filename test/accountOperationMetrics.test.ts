import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { AccountService } from '../src/services/accountService.js';

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };

describe('withAccountOperationMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  /**
   * Fresh MeterProvider + fresh module graph per test: instruments.ts binds
   * its Meter once, at module-load time, so the decorator module must be
   * (re-)imported *after* a provider is registered to bind to it. See
   * mailboxServiceMetrics.test.ts for the full explanation.
   */
  const loadDecorator = async (): Promise<
    typeof import('../src/telemetry/accountOperationMetrics.js')['withAccountOperationMetrics']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { withAccountOperationMetrics } = await import(
      '../src/telemetry/accountOperationMetrics.js'
    );
    return withAccountOperationMetrics;
  };

  const histogramPoints = async (): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, 'mailtool.account.operation.duration');
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  it('records outcome "success" for a successful listAccounts call', async () => {
    const withAccountOperationMetrics = await loadDecorator();
    const summaries = [{ id: 'acc-1', host: 'imap.example.com', watchMailboxes: ['INBOX'] }];
    const inner: AccountService = { listAccounts: vi.fn(() => Promise.resolve(summaries)) };
    const service = withAccountOperationMetrics(inner);

    const result = await service.listAccounts();

    expect(result).toBe(summaries);
    const points = await histogramPoints();
    expect(points).toHaveLength(1);
    expect(points[0]!.attributes).toMatchObject({ operation: 'list_accounts', outcome: 'success' });
    expect(points[0]!.value.count).toBe(1);
  });

  it('records outcome "error" and rethrows on failure', async () => {
    const withAccountOperationMetrics = await loadDecorator();
    const originalError = new Error('boom');
    const inner: AccountService = { listAccounts: vi.fn(() => Promise.reject(originalError)) };
    const service = withAccountOperationMetrics(inner);

    await expect(service.listAccounts()).rejects.toBe(originalError);

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({ operation: 'list_accounts', outcome: 'error' });
  });
});
