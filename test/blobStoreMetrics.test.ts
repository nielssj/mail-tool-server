import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { BlobStore, StagedBlob } from '../src/storage/blobStore.js';

const STAGED: StagedBlob = { url: 'https://example.com/staged', expiresAt: '2024-06-01T00:15:00.000Z' };

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };

describe('withBlobStoreMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  const loadDecorator = async (): Promise<
    typeof import('../src/telemetry/blobStoreMetrics.js')['withBlobStoreMetrics']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { withBlobStoreMetrics } = await import('../src/telemetry/blobStoreMetrics.js');
    return withBlobStoreMetrics;
  };

  const histogramPoints = async (metricName: string): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, metricName);
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  it('records duration and byte size for a staged attachment', async () => {
    const withBlobStoreMetrics = await loadDecorator();
    const inner: BlobStore = { stage: vi.fn(() => Promise.resolve(STAGED)) };
    const store = withBlobStoreMetrics(inner);
    const body = Buffer.from('%PDF-1.4 fake bytes');

    const result = await store.stage({ body, filename: 'invoice.pdf', kind: 'attachment' });

    expect(result).toBe(STAGED);
    const durationPoints = await histogramPoints('mailtool.blobstore.stage.duration');
    expect(durationPoints[0]!.attributes).toMatchObject({ kind: 'attachment', outcome: 'ok' });

    const bytePoints = await histogramPoints('mailtool.blobstore.stage.bytes');
    expect(bytePoints[0]!.attributes).toMatchObject({ kind: 'attachment' });
    expect(bytePoints[0]!.value.sum).toBe(body.length);
  });

  it('records duration and byte size for a staged full-message export, tagged "message"', async () => {
    const withBlobStoreMetrics = await loadDecorator();
    const inner: BlobStore = { stage: vi.fn(() => Promise.resolve(STAGED)) };
    const store = withBlobStoreMetrics(inner);
    const body = Buffer.from('From: a@example.com\r\n\r\nbody');

    await store.stage({ body, filename: 'message-7.eml', kind: 'message' });

    const durationPoints = await histogramPoints('mailtool.blobstore.stage.duration');
    expect(durationPoints[0]!.attributes).toMatchObject({ kind: 'message', outcome: 'ok' });

    const bytePoints = await histogramPoints('mailtool.blobstore.stage.bytes');
    expect(bytePoints[0]!.attributes).toMatchObject({ kind: 'message' });
    expect(bytePoints[0]!.value.sum).toBe(body.length);
  });

  it('records duration with outcome "error" and rethrows on failure, without recording bytes', async () => {
    const withBlobStoreMetrics = await loadDecorator();
    const originalError = new Error('S3 unavailable');
    const inner: BlobStore = { stage: vi.fn(() => Promise.reject(originalError)) };
    const store = withBlobStoreMetrics(inner);

    await expect(
      store.stage({ body: Buffer.from('x'), filename: 'x.bin', kind: 'attachment' })
    ).rejects.toBe(originalError);

    const durationPoints = await histogramPoints('mailtool.blobstore.stage.duration');
    expect(durationPoints[0]!.attributes).toMatchObject({ kind: 'attachment', outcome: 'error' });

    const bytePoints = await histogramPoints('mailtool.blobstore.stage.bytes');
    expect(bytePoints).toHaveLength(0);
  });
});
