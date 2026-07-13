import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { CollectionResult, MetricData } from '@opentelemetry/sdk-metrics';

/**
 * Test-only in-memory metrics harness — registers a MeterProvider backed by
 * a MetricReader that collects current instrument values on demand, with no
 * periodic export interval to wait on. Only ever imported from test/.
 */
class OnDemandMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

export type MetricsTestHarness = {
  /** Reads all currently recorded instrument values. */
  collect: () => Promise<CollectionResult>;
  /** Unregisters the MeterProvider so subsequent tests start clean. */
  shutdown: () => Promise<void>;
};

export const setupMetricsTestHarness = (): MetricsTestHarness => {
  const reader = new OnDemandMetricReader();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  return {
    collect: () => reader.collect(),
    shutdown: async () => {
      await provider.shutdown();
      metrics.disable();
    }
  };
};

/** Finds a single collected metric by its instrument name, across all scopes. */
export const findMetric = (
  result: CollectionResult,
  metricName: string
): MetricData | undefined => {
  for (const scopeMetrics of result.resourceMetrics.scopeMetrics) {
    const metric = scopeMetrics.metrics.find((m) => m.descriptor.name === metricName);
    if (metric) {
      return metric;
    }
  }
  return undefined;
};
