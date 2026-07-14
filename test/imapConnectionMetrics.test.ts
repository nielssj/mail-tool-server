import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { MailboxClient, MailboxClientConstructor } from '../src/services/mailboxService.js';

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };
type SumPoint = { attributes: Record<string, unknown>; value: number };

const makeFakeCtor = (overrides: {
  connect?: () => Promise<void>;
  list?: () => Promise<unknown[]>;
} = {}): { ctor: MailboxClientConstructor; connect: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } => {
  const connect = vi.fn(overrides.connect ?? (() => Promise.resolve()));
  const list = vi.fn(overrides.list ?? (() => Promise.resolve(['INBOX'])));

  class FakeMailboxClient {
    connect = connect;
    logout = vi.fn(() => Promise.resolve());
    list = list;
    mailboxOpen = vi.fn(() => Promise.resolve({}));
    fetchAll = vi.fn(() => Promise.resolve([]));
    fetchOne = vi.fn(() => Promise.resolve(false));
    download = vi.fn(() => Promise.resolve({ meta: {}, content: null }));
    messageMove = vi.fn(() => Promise.resolve(false));
    messageFlagsAdd = vi.fn(() => Promise.resolve(true));
    messageFlagsRemove = vi.fn(() => Promise.resolve(true));
  }

  return { ctor: FakeMailboxClient as unknown as MailboxClientConstructor, connect, list };
};

describe('withConnectionMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  /**
   * Fresh MeterProvider + fresh module graph per test — same ordering
   * constraint as the other telemetry decorator tests (see
   * mailboxServiceMetrics.test.ts for the full explanation).
   */
  const loadDecorator = async (): Promise<
    typeof import('../src/telemetry/imapConnectionMetrics.js')['withConnectionMetrics']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { withConnectionMetrics } = await import('../src/telemetry/imapConnectionMetrics.js');
    return withConnectionMetrics;
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

  it('records connection success (outcome "ok") labeled by the account id passed to the constructor', async () => {
    const withConnectionMetrics = await loadDecorator();
    const { ctor, connect } = makeFakeCtor();
    const InstrumentedCtor = withConnectionMetrics(ctor);

    const client = new InstrumentedCtor({
      id: 'acc-1',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'user@example.com', pass: 'secret' }
    }) as MailboxClient;
    await client.connect();

    expect(connect).toHaveBeenCalledTimes(1);
    const points = await histogramPoints('mailtool.imap.connection.duration');
    expect(points).toHaveLength(1);
    expect(points[0]!.attributes).toMatchObject({ 'account.id': 'acc-1', outcome: 'ok' });
    expect(points[0]!.value.count).toBe(1);
  });

  it('records connection failure (duration + error counter) and rethrows the original error unchanged', async () => {
    const withConnectionMetrics = await loadDecorator();
    const originalError = new Error('socket timeout');
    const { ctor } = makeFakeCtor({ connect: () => Promise.reject(originalError) });
    const InstrumentedCtor = withConnectionMetrics(ctor);

    const client = new InstrumentedCtor({
      id: 'acc-2',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'user@example.com', pass: 'secret' }
    }) as MailboxClient;

    await expect(client.connect()).rejects.toBe(originalError);

    const durationPoints = await histogramPoints('mailtool.imap.connection.duration');
    expect(durationPoints[0]!.attributes).toMatchObject({ 'account.id': 'acc-2', outcome: 'error' });

    const errorPoints = await sumPoints('mailtool.imap.connection.errors');
    expect(errorPoints).toHaveLength(1);
    expect(errorPoints[0]!.attributes).toMatchObject({ 'account.id': 'acc-2' });
    expect(errorPoints[0]!.value).toBe(1);
  });

  it('delegates every other MailboxClient method to the wrapped client unchanged', async () => {
    const withConnectionMetrics = await loadDecorator();
    const mailboxes = ['INBOX', 'Archive'];
    const { ctor, list } = makeFakeCtor({ list: () => Promise.resolve(mailboxes) });
    const InstrumentedCtor = withConnectionMetrics(ctor);

    const client = new InstrumentedCtor({
      id: 'acc-1',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'user@example.com', pass: 'secret' }
    }) as MailboxClient;

    const result = await client.list();

    expect(list).toHaveBeenCalledTimes(1);
    expect(result).toBe(mailboxes);
  });
});
