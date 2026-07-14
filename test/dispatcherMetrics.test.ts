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
  data: { count: 5, previousCount: 4 },
  timestamp: '2024-06-01T00:00:00.000Z'
};

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };
type SumPoint = { attributes: Record<string, unknown>; value: number };

describe('dispatcherMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  const loadModules = async (): Promise<{
    withDispatcherMetrics: typeof import('../src/telemetry/dispatcherMetrics.js')['withDispatcherMetrics'];
    createAttemptObserver: typeof import('../src/telemetry/dispatcherMetrics.js')['createAttemptObserver'];
  }> => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    return import('../src/telemetry/dispatcherMetrics.js');
  };

  const histogramPoints = async (metricName: string): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, metricName);
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  const sumPoints = async (metricName: string): Promise<SumPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, metricName);
    return (metric?.dataPoints ?? []) as SumPoint[];
  };

  describe('withDispatcherMetrics', () => {
    it('records duration with outcome "ok" on success, tagged from the event', async () => {
      const { withDispatcherMetrics } = await loadModules();
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
      const { withDispatcherMetrics } = await loadModules();
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

  describe('createAttemptObserver', () => {
    it('records an attempt with the bound account id and given outcome', async () => {
      const { createAttemptObserver } = await loadModules();
      const onAttempt = createAttemptObserver('acc-1');

      onAttempt('ok');
      onAttempt('error');

      const points = await sumPoints('mailtool.dispatcher.webhook.attempts');
      expect(points).toHaveLength(2);
      expect(points).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: expect.objectContaining({ 'account.id': 'acc-1', outcome: 'ok' }),
            value: 1
          }),
          expect.objectContaining({
            attributes: expect.objectContaining({ 'account.id': 'acc-1', outcome: 'error' }),
            value: 1
          })
        ])
      );
    });
  });
});
