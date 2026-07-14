import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };

describe('withToolMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  const loadDecorator = async (): Promise<
    typeof import('../src/telemetry/mcpToolMetrics.js')['withToolMetrics']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { withToolMetrics } = await import('../src/telemetry/mcpToolMetrics.js');
    return withToolMetrics;
  };

  const histogramPoints = async (): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, 'mailtool.mcp.tool.duration');
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  it('records outcome "ok" for a plain successful result', async () => {
    const withToolMetrics = await loadDecorator();
    const handler = vi.fn(async (n: number) => ({ doubled: n * 2 }));
    const wrapped = withToolMetrics('list_accounts', handler);

    const result = await wrapped(21);

    expect(result).toEqual({ doubled: 42 });
    const points = await histogramPoints();
    expect(points).toHaveLength(1);
    expect(points[0]!.attributes).toMatchObject({ tool: 'list_accounts', outcome: 'ok' });
    expect(points[0]!.value.count).toBe(1);
  });

  it('records the mapped error code for a withToolErrors-shaped error result', async () => {
    const withToolMetrics = await loadDecorator();
    const errorResult = {
      content: [{ type: 'text', text: 'Message not found' }],
      structuredContent: { error: { code: 'NOT_FOUND', message: 'Message not found' } },
      isError: true as const
    };
    const handler = vi.fn(async () => errorResult);
    const wrapped = withToolMetrics('get_message', handler);

    const result = await wrapped();

    expect(result).toBe(errorResult);
    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({ tool: 'get_message', outcome: 'NOT_FOUND' });
  });

  it('falls back to outcome "error" when isError is true but no code is present', async () => {
    const withToolMetrics = await loadDecorator();
    const handler = vi.fn(async () => ({ isError: true as const }));
    const wrapped = withToolMetrics('list_mailboxes', handler);

    await wrapped();

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({ tool: 'list_mailboxes', outcome: 'error' });
  });
});
