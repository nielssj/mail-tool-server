import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { Dispatcher } from '../src/events/dispatcher.js';
import type { DomainEvent } from '../src/events/types.js';

const NEW_MAIL_EVENT: DomainEvent = {
  event: 'newMail',
  accountId: 'acc-1',
  mailbox: 'INBOX',
  data: { uid: 5, count: 5 },
  timestamp: '2024-06-01T00:00:00.000Z'
};

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };

describe('withDispatcherMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  const loadDecorator = async (): Promise<
    typeof import('../src/telemetry/dispatcherMetrics.js')['withDispatcherMetrics']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { withDispatcherMetrics } = await import('../src/telemetry/dispatcherMetrics.js');
    return withDispatcherMetrics;
  };

  const histogramPoints = async (metricName: string): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, metricName);
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  it('records duration with outcome "ok" on success, tagged from the event', async () => {
    const withDispatcherMetrics = await loadDecorator();
    const inner: Dispatcher = { handle: vi.fn(() => Promise.resolve()) };
    const dispatcher = withDispatcherMetrics(inner);

    await dispatcher.handle(NEW_MAIL_EVENT);

    expect(inner.handle).toHaveBeenCalledWith(NEW_MAIL_EVENT);
    const points = await histogramPoints('mailtool.dispatcher.webhook.duration');
    expect(points).toHaveLength(1);
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'acc-1',
      event: 'newMail',
      outcome: 'ok'
    });
    expect(points[0]!.value.count).toBe(1);
  });

  it('records duration with outcome "error" and rethrows on failure', async () => {
    const withDispatcherMetrics = await loadDecorator();
    const originalError = new Error('delivery failed');
    const inner: Dispatcher = { handle: vi.fn(() => Promise.reject(originalError)) };
    const dispatcher = withDispatcherMetrics(inner);

    await expect(dispatcher.handle(NEW_MAIL_EVENT)).rejects.toBe(originalError);

    const points = await histogramPoints('mailtool.dispatcher.webhook.duration');
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'acc-1',
      event: 'newMail',
      outcome: 'error'
    });
  });
});
