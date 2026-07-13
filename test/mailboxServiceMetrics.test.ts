import { Readable } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { MailboxClientConstructor } from '../src/services/mailboxService.js';
import type { ListResponse } from 'imapflow';

const ACCOUNT = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: { user: 'user@example.com', pass: 'secret' },
  watchMailboxes: ['INBOX'],
  dispatchers: []
};

const READ_ONLY_ACCOUNT = { ...ACCOUNT, id: 'acc-ro', readOnly: true };
const ACCOUNTS = [ACCOUNT, READ_ONLY_ACCOUNT];

const makeListResponse = (path: string): ListResponse => ({
  path,
  pathAsListed: path,
  name: path,
  delimiter: '/',
  parent: [],
  parentPath: '',
  flags: new Set(),
  listed: true,
  subscribed: false
});

type MockClientOverrides = Partial<{
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  list: () => Promise<ListResponse[]>;
  mailboxOpen: () => Promise<object>;
  fetchAll: () => Promise<unknown[]>;
  fetchOne: () => Promise<unknown>;
  download: () => Promise<{ meta: object; content: Readable }>;
  messageMove: () => Promise<unknown>;
  messageFlagsAdd: () => Promise<boolean>;
  messageFlagsRemove: () => Promise<boolean>;
}>;

const buildMockCtor = (overrides: MockClientOverrides = {}): MailboxClientConstructor => {
  class MockMailboxClient {
    connect = vi.fn(overrides.connect ?? (() => Promise.resolve()));
    logout = vi.fn(overrides.logout ?? (() => Promise.resolve()));
    list = vi.fn(overrides.list ?? (() => Promise.resolve([])));
    mailboxOpen = vi.fn(overrides.mailboxOpen ?? (() => Promise.resolve({})));
    fetchAll = vi.fn(overrides.fetchAll ?? (() => Promise.resolve([])));
    fetchOne = vi.fn(overrides.fetchOne ?? (() => Promise.resolve(false)));
    download = vi.fn(
      overrides.download ??
        (() =>
          Promise.resolve({ meta: { contentType: 'text/plain' }, content: Readable.from([]) }))
    );
    messageMove = vi.fn(overrides.messageMove ?? (() => Promise.resolve(false)));
    messageFlagsAdd = vi.fn(overrides.messageFlagsAdd ?? (() => Promise.resolve(true)));
    messageFlagsRemove = vi.fn(overrides.messageFlagsRemove ?? (() => Promise.resolve(true)));
  }

  return MockMailboxClient as unknown as MailboxClientConstructor;
};

type HistogramPoint = { attributes: Record<string, unknown>; value: Histogram };
type SumPoint = { attributes: Record<string, unknown>; value: number };

describe('mailboxService metrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  /**
   * Fresh MeterProvider + fresh module graph per test: instruments.ts binds
   * its Meter once, at module-load time, so mailboxService.ts must be
   * (re-)imported *after* a provider is registered to bind to it — the same
   * ordering constraint production relies on (register the SDK before any
   * application code loads). vi.resetModules() forces that re-evaluation;
   * without it, every test after the first would keep recording against the
   * previous (shut-down) test's provider.
   */
  const loadService = async (): Promise<
    typeof import('../src/services/mailboxService.js')['createMailboxService']
  > => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { createMailboxService } = await import('../src/services/mailboxService.js');
    return createMailboxService;
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

  describe('mailtool.mailbox.operation.duration — success, per operation', () => {
    it('list_mailboxes', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor({ list: () => Promise.resolve([makeListResponse('INBOX')]) });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.listMailboxes('acc-1');

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points).toHaveLength(1);
      expect(points[0]!.attributes).toMatchObject({
        'account.id': 'acc-1',
        operation: 'list_mailboxes',
        outcome: 'success'
      });
      expect(points[0]!.value.count).toBe(1);
    });

    it('list_messages', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.listMessages('acc-1', 'INBOX');

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points[0]!.attributes).toMatchObject({ operation: 'list_messages', outcome: 'success' });
    });

    it('get_message', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({ uid: 1, flags: new Set(), envelope: {}, internalDate: new Date(), size: 10 })
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.getMessage('acc-1', 'INBOX', 1);

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points[0]!.attributes).toMatchObject({ operation: 'get_message', outcome: 'success' });
    });

    it('get_attachment', async () => {
      const createMailboxService = await loadService();
      const bodyStructure = {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', size: 20 },
          {
            part: '2',
            type: 'application/pdf',
            size: 5000,
            disposition: 'attachment',
            dispositionParameters: { filename: 'invoice.pdf' }
          }
        ]
      };
      const ctor = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({
            uid: 1,
            flags: new Set(),
            envelope: {},
            internalDate: new Date(),
            size: 10,
            bodyStructure
          }),
        download: () =>
          Promise.resolve({
            meta: { contentType: 'application/pdf' },
            content: Readable.from([Buffer.from('pdf-bytes')])
          })
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.getAttachment('acc-1', 'INBOX', 1, '2');

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points[0]!.attributes).toMatchObject({ operation: 'get_attachment', outcome: 'success' });
    });

    it('get_raw_source', async () => {
      const createMailboxService = await loadService();
      const source = Buffer.from('From: a@example.com\r\n\r\nbody');
      const ctor = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({
            uid: 1,
            flags: new Set(),
            envelope: {},
            internalDate: new Date(),
            size: 10,
            source
          })
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.getRawSource('acc-1', 'INBOX', 1);

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points[0]!.attributes).toMatchObject({ operation: 'get_raw_source', outcome: 'success' });
    });

    it('move_message', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor({
        messageMove: () => Promise.resolve({ uidValidity: BigInt(1), uid: 5, destination: 'Archive' })
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.moveMessage('acc-1', 'INBOX', 5, 'Archive');

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points[0]!.attributes).toMatchObject({ operation: 'move_message', outcome: 'success' });
    });

    it('set_flags', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.setFlags('acc-1', 'INBOX', 3, ['\\Flagged'], []);

      const points = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(points[0]!.attributes).toMatchObject({ operation: 'set_flags', outcome: 'success' });
    });
  });

  it('records outcome "not_found" when an operation returns false (e.g. unknown uid)', async () => {
    const createMailboxService = await loadService();
    const ctor = buildMockCtor({ fetchOne: () => Promise.resolve(false) });
    const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

    const result = await service.getMessage('acc-1', 'INBOX', 999);
    expect(result).toBe(false);

    const points = await histogramPoints('mailtool.mailbox.operation.duration');
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'acc-1',
      operation: 'get_message',
      outcome: 'not_found'
    });
  });

  it('records outcome "not_found" with account.id "unknown" for an unrecognized accountId', async () => {
    const createMailboxService = await loadService();
    const ctor = buildMockCtor();
    const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

    await expect(service.listMailboxes('no-such-account')).rejects.toThrow(/Unknown account id/);

    const points = await histogramPoints('mailtool.mailbox.operation.duration');
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'unknown',
      operation: 'list_mailboxes',
      outcome: 'not_found'
    });
  });

  it('records outcome "read_only" when a mutation is rejected for a read-only account', async () => {
    const createMailboxService = await loadService();
    const ctor = buildMockCtor();
    const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

    await expect(service.moveMessage('acc-ro', 'INBOX', 5, 'Archive')).rejects.toThrow(
      /read-only/
    );

    const points = await histogramPoints('mailtool.mailbox.operation.duration');
    expect(points[0]!.attributes).toMatchObject({
      'account.id': 'acc-ro',
      operation: 'move_message',
      outcome: 'read_only'
    });
  });

  it('records outcome "error" for an unrecognized thrown error', async () => {
    const createMailboxService = await loadService();
    const ctor = buildMockCtor({ list: () => Promise.reject(new Error('list failed')) });
    const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

    await expect(service.listMailboxes('acc-1')).rejects.toThrow('list failed');

    const points = await histogramPoints('mailtool.mailbox.operation.duration');
    expect(points[0]!.attributes).toMatchObject({
      operation: 'list_mailboxes',
      outcome: 'error'
    });
  });

  describe('IMAP connection metrics', () => {
    it('records connection success (outcome "ok") alongside a successful operation', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await service.listMailboxes('acc-1');

      const points = await histogramPoints('mailtool.imap.connection.duration');
      expect(points).toHaveLength(1);
      expect(points[0]!.attributes).toMatchObject({ 'account.id': 'acc-1', outcome: 'ok' });
      expect(points[0]!.value.count).toBe(1);
    });

    it('records connection failure (duration + error counter) and propagates "imap_connection_error" outcome', async () => {
      const createMailboxService = await loadService();
      const ctor = buildMockCtor({ connect: () => Promise.reject(new Error('socket timeout')) });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });

      await expect(service.listMailboxes('acc-1')).rejects.toThrow();

      const durationPoints = await histogramPoints('mailtool.imap.connection.duration');
      expect(durationPoints[0]!.attributes).toMatchObject({ 'account.id': 'acc-1', outcome: 'error' });

      const errorPoints = await sumPoints('mailtool.imap.connection.errors');
      expect(errorPoints).toHaveLength(1);
      expect(errorPoints[0]!.attributes).toMatchObject({ 'account.id': 'acc-1' });
      expect(errorPoints[0]!.value).toBe(1);

      const operationPoints = await histogramPoints('mailtool.mailbox.operation.duration');
      expect(operationPoints[0]!.attributes).toMatchObject({
        operation: 'list_mailboxes',
        outcome: 'imap_connection_error'
      });
    });
  });
});
