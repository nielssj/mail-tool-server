import { describe, expect, it, afterEach } from 'vitest';
import { DataPointType, type Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';

describe('telemetry instruments', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  it('records a value through a real named instrument and round-trips it via the test harness', async () => {
    harness = setupMetricsTestHarness();

    // Dynamically imported *after* the harness registers the global
    // MeterProvider: instruments.ts creates its Meter once, at module-load
    // time, so it must load after a provider is registered to bind to it —
    // the same ordering constraint production relies on (register the SDK
    // before any application code loads, e.g. via `--require`).
    const { mailboxOperationDuration } = await import('../src/telemetry/instruments.js');

    mailboxOperationDuration.record(0.042, { operation: 'list_mailboxes', outcome: 'success' });

    const result = await harness.collect();
    const metric = findMetric(result, 'mailtool.mailbox.operation.duration');

    expect(metric).toBeDefined();
    expect(metric?.dataPointType).toBe(DataPointType.HISTOGRAM);

    const dataPoints = metric!.dataPoints as { attributes: Record<string, unknown>; value: Histogram }[];
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0]!.attributes).toMatchObject({
      operation: 'list_mailboxes',
      outcome: 'success'
    });
    expect(dataPoints[0]!.value.count).toBe(1);
    expect(dataPoints[0]!.value.sum).toBeCloseTo(0.042, 5);
  });
});
