import { describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { getMeter } from '../src/telemetry/metrics.js';

describe('getMeter', () => {
  it('creates and records against instruments without throwing when no MeterProvider is registered', () => {
    metrics.disable();

    const meter = getMeter('mail-tool-server-test', '0.0.0');

    expect(() => {
      const counter = meter.createCounter('test.noop.counter');
      counter.add(1, { foo: 'bar' });

      const histogram = meter.createHistogram('test.noop.histogram');
      histogram.record(42);

      const gauge = meter.createObservableGauge('test.noop.gauge');
      gauge.addCallback((result) => result.observe(1));
    }).not.toThrow();
  });
});
