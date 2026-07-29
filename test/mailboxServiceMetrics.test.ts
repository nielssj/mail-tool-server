import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { AccountConfig } from '../src/utils/config/schema.js';
import type { MailboxService } from '../src/services/mailboxService.js';

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

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };

const makeFakeService = (overrides: Partial<Record<keyof MailboxService, () => unknown>> = {}): MailboxService =>
  ({
    listMailboxes: vi.fn(overrides.listMailboxes ?? (() => Promise.resolve([]))),
    listMessages: vi.fn(overrides.listMessages ?? (() => Promise.resolve([]))),
    getMessage: vi.fn(overrides.getMessage ?? (() => Promise.resolve(false))),
    getAttachment: vi.fn(overrides.getAttachment ?? (() => Promise.resolve(false))),
    getRawSource: vi.fn(overrides.getRawSource ?? (() => Promise.resolve(false))),
    moveMessage: vi.fn(overrides.moveMessage ?? (() => Promise.resolve(false))),
    setFlags: vi.fn(overrides.setFlags ?? (() => Promise.resolve(undefined))),
    createDraft: vi.fn(overrides.createDraft ?? (() => Promise.resolve({ mailbox: 'Drafts' })))
  }) as unknown as MailboxService;

describe('withMailboxOperationMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  /**
   * Fresh MeterProvider + fresh module graph per test: instruments.ts binds
   * its Meter once, at module-load time, so the decorator module must be
   * (re-)imported *after* a provider is registered to bind to it — the same
   * ordering constraint production relies on (register the SDK before any
   * application code loads). vi.resetModules() forces that re-evaluation.
   */
  const loadDecorator = async (): Promise<
    typeof import('../src/telemetry/mailboxOperationMetrics.js')['withMailboxOperationMetrics']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { withMailboxOperationMetrics } = await import(
      '../src/telemetry/mailboxOperationMetrics.js'
    );
    return withMailboxOperationMetrics;
  };

  const histogramPoints = async (): Promise<HistogramPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, 'mailtool.mailbox.operation.duration');
    return (metric?.dataPoints ?? []) as HistogramPoint[];
  };

  describe('success, per operation', () => {
    it('list_mailboxes', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(makeFakeService(), ACCOUNTS);

      await service.listMailboxes('acc-1');

      const points = await histogramPoints();
      expect(points).toHaveLength(1);
      expect(points[0]!.attributes).toMatchObject({
        'account.id': 'acc-1',
        operation: 'list_mailboxes',
        outcome: 'success'
      });
      expect(points[0]!.value.count).toBe(1);
    });

    it('list_messages', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(makeFakeService(), ACCOUNTS);

      await service.listMessages('acc-1', 'INBOX');

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'list_messages', outcome: 'success' });
    });

    it('get_message', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(
        makeFakeService({ getMessage: () => Promise.resolve({ uid: 1 }) }),
        ACCOUNTS
      );

      await service.getMessage('acc-1', 'INBOX', 1);

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'get_message', outcome: 'success' });
    });

    it('get_attachment', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(
        makeFakeService({ getAttachment: () => Promise.resolve({ filename: 'a.pdf' }) }),
        ACCOUNTS
      );

      await service.getAttachment('acc-1', 'INBOX', 1, '2');

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'get_attachment', outcome: 'success' });
    });

    it('get_raw_source', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(
        makeFakeService({ getRawSource: () => Promise.resolve(Buffer.from('raw')) }),
        ACCOUNTS
      );

      await service.getRawSource('acc-1', 'INBOX', 1);

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'get_raw_source', outcome: 'success' });
    });

    it('move_message', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(
        makeFakeService({ moveMessage: () => Promise.resolve({ uid: 5 }) }),
        ACCOUNTS
      );

      await service.moveMessage('acc-1', 'INBOX', 5, 'Archive');

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'move_message', outcome: 'success' });
    });

    it('set_flags', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(makeFakeService(), ACCOUNTS);

      await service.setFlags('acc-1', 'INBOX', 3, ['\\Flagged'], []);

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'set_flags', outcome: 'success' });
    });

    it('create_draft', async () => {
      const withMailboxOperationMetrics = await loadDecorator();
      const service = withMailboxOperationMetrics(makeFakeService(), ACCOUNTS);

      await service.createDraft('acc-1', 'Drafts', {});

      const points = await histogramPoints();
      expect(points[0]!.attributes).toMatchObject({ operation: 'create_draft', outcome: 'success' });
    });
  });

  it('records outcome "not_found" when an operation returns false', async () => {
    const withMailboxOperationMetrics = await loadDecorator();
    const service = withMailboxOperationMetrics(makeFakeService(), ACCOUNTS);

    const result = await service.getMessage('acc-1', 'INBOX', 999);
    expect(result).toBe(false);

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'acc-1',
      operation: 'get_message',
      outcome: 'not_found'
    });
  });

  it('labels account.id as "unknown" for an accountId outside the configured set', async () => {
    const withMailboxOperationMetrics = await loadDecorator();
    const notFound = () => Promise.reject(new Error('Unknown account id: "no-such-account"'));
    const service = withMailboxOperationMetrics(makeFakeService({ listMailboxes: notFound }), ACCOUNTS);

    await expect(service.listMailboxes('no-such-account')).rejects.toThrow(/Unknown account id/);

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'unknown',
      operation: 'list_mailboxes',
      outcome: 'not_found'
    });
  });

  it('records outcome "read_only" for an error named ReadOnlyAccountError', async () => {
    const withMailboxOperationMetrics = await loadDecorator();
    const readOnlyError = () => {
      const error = new Error('Account "acc-1" is read-only; move_message is disabled.');
      error.name = 'ReadOnlyAccountError';
      return Promise.reject(error);
    };
    const service = withMailboxOperationMetrics(makeFakeService({ moveMessage: readOnlyError }), ACCOUNTS);

    await expect(service.moveMessage('acc-1', 'INBOX', 5, 'Archive')).rejects.toThrow(/read-only/);

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'acc-1',
      operation: 'move_message',
      outcome: 'read_only'
    });
  });

  it('records outcome "imap_connection_error" for an error named ImapConnectionError', async () => {
    const withMailboxOperationMetrics = await loadDecorator();
    const connectionError = () => {
      const error = new Error('Failed to connect to IMAP account "acc-1"');
      error.name = 'ImapConnectionError';
      return Promise.reject(error);
    };
    const service = withMailboxOperationMetrics(
      makeFakeService({ listMailboxes: connectionError }),
      ACCOUNTS
    );

    await expect(service.listMailboxes('acc-1')).rejects.toThrow();

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({
      operation: 'list_mailboxes',
      outcome: 'imap_connection_error'
    });
  });

  it('records outcome "error" for an unrecognized thrown error', async () => {
    const withMailboxOperationMetrics = await loadDecorator();
    const service = withMailboxOperationMetrics(
      makeFakeService({ listMailboxes: () => Promise.reject(new Error('list failed')) }),
      ACCOUNTS
    );

    await expect(service.listMailboxes('acc-1')).rejects.toThrow('list failed');

    const points = await histogramPoints();
    expect(points[0]!.attributes).toMatchObject({ operation: 'list_mailboxes', outcome: 'error' });
  });
});
