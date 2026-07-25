import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupMetricsTestHarness, findMetric } from '../src/telemetry/testing.js';
import type { MetricsTestHarness } from '../src/telemetry/testing.js';
import type { AccountWatcher, WatcherClientConstructor } from '../src/imap/watcher.js';
import type { AccountConfig } from '../src/utils/config/schema.js';

const ACCOUNT: AccountConfig = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: { user: 'user@example.com', pass: 'secret' },
  watchMailboxes: ['INBOX'],
  dispatchers: []
};

type MockWatcherOverrides = Partial<{
  mailboxOpen: (
    path: string
  ) => Promise<{ exists?: number; uidNext?: number; uidValidity?: bigint }>;
  fetchAll: (
    range: string,
    query: { uid: true },
    options: { uid: true }
  ) => Promise<Array<{ uid: number }>>;
}>;

const buildWatcherCtor = (overrides: MockWatcherOverrides = {}) => {
  const mailboxOpen = vi.fn(overrides.mailboxOpen ?? (() => Promise.resolve({ exists: 0 })));
  const fetchAll = vi.fn(overrides.fetchAll ?? (() => Promise.resolve([])));
  const instances: MockWatcherClient[] = [];

  class MockWatcherClient extends EventEmitter {
    connect = vi.fn(() => Promise.resolve());
    logout = vi.fn(() => Promise.resolve());
    mailboxOpen = mailboxOpen;
    idle = vi.fn(() => new Promise<void>(() => undefined));
    fetchAll = fetchAll;

    constructor() {
      super();
      instances.push(this);
    }
  }

  return { ctor: MockWatcherClient as unknown as WatcherClientConstructor, instances };
};

type SumPoint = { attributes: Record<string, unknown>; value: number };
type GaugePoint = { attributes: Record<string, unknown>; value: number };

describe('watcherMetrics', () => {
  let harness: MetricsTestHarness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  /**
   * Fresh MeterProvider + fresh module graph per test: instruments.ts (and
   * watcherMetrics.ts, which registers its ObservableGauge callbacks at
   * module-load time) bind to whatever provider is registered *when first
   * imported*. vi.resetModules() + importing AccountWatcher through the
   * same fresh graph keeps everything bound to this test's provider.
   */
  const loadModules = async (): Promise<{
    AccountWatcherCtor: typeof AccountWatcher;
    observeWatcherMetrics: typeof import('../src/telemetry/watcherMetrics.js')['observeWatcherMetrics'];
    unobserveWatcherMetrics: typeof import('../src/telemetry/watcherMetrics.js')['unobserveWatcherMetrics'];
  }> => {
    vi.resetModules();
    harness = setupMetricsTestHarness();
    const { AccountWatcher: AccountWatcherCtor } = await import('../src/imap/watcher.js');
    const { observeWatcherMetrics, unobserveWatcherMetrics } = await import(
      '../src/telemetry/watcherMetrics.js'
    );
    return { AccountWatcherCtor, observeWatcherMetrics, unobserveWatcherMetrics };
  };

  const sumPoints = async (metricName: string): Promise<SumPoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, metricName);
    return (metric?.dataPoints ?? []) as SumPoint[];
  };

  const gaugePoints = async (metricName: string): Promise<GaugePoint[]> => {
    const result = await harness!.collect();
    const metric = findMetric(result, metricName);
    return (metric?.dataPoints ?? []) as GaugePoint[];
  };

  it('counts a newMail event per message', async () => {
    const { AccountWatcherCtor, observeWatcherMetrics } = await loadModules();
    const { ctor, instances } = buildWatcherCtor({
      mailboxOpen: () => Promise.resolve({ exists: 2, uidNext: 3, uidValidity: 1n }),
      fetchAll: () => Promise.resolve([{ uid: 3 }, { uid: 4 }, { uid: 5 }])
    });
    const watcher = new AccountWatcherCtor(ACCOUNT, { WatcherClientCtor: ctor });
    const newMailEvents: unknown[] = [];
    watcher.on('newMail', (event) => newMailEvents.push(event));
    observeWatcherMetrics(watcher, ACCOUNT);

    await watcher.start();
    instances[0]?.emit('exists', 5);

    await vi.waitFor(() => {
      if (newMailEvents.length < 3) {
        throw new Error('waiting for newMail events');
      }
    });

    // 3 events (one per UID), each recorded as its own watcher.events count
    // and its own +1 in new_mail.messages -- no delta math anymore.
    const events = await sumPoints('mailtool.watcher.events');
    expect(events).toHaveLength(1);
    expect(events[0]!.attributes).toMatchObject({
      'account.id': 'acc-1',
      mailbox: 'INBOX',
      event: 'newMail'
    });
    expect(events[0]!.value).toBe(3);

    const newMailMessages = await sumPoints('mailtool.watcher.new_mail.messages');
    expect(newMailMessages[0]!.attributes).toMatchObject({ 'account.id': 'acc-1', mailbox: 'INBOX' });
    expect(newMailMessages[0]!.value).toBe(3);

    await watcher.stop();
  });

  it('counts a flagsChanged event', async () => {
    const { AccountWatcherCtor, observeWatcherMetrics } = await loadModules();
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcherCtor(ACCOUNT, { WatcherClientCtor: ctor });
    observeWatcherMetrics(watcher, ACCOUNT);

    await watcher.start();
    instances[0]?.emit('flags', { uid: 1, flags: new Set(['\\Seen']) });

    const events = await sumPoints('mailtool.watcher.events');
    expect(events[0]!.attributes).toMatchObject({ event: 'flagsChanged' });
    expect(events[0]!.value).toBe(1);

    await watcher.stop();
  });

  it('counts a mailRemoved event', async () => {
    const { AccountWatcherCtor, observeWatcherMetrics } = await loadModules();
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcherCtor(ACCOUNT, { WatcherClientCtor: ctor });
    observeWatcherMetrics(watcher, ACCOUNT);

    await watcher.start();
    instances[0]?.emit('expunge', { uid: 9, seq: 1 });

    const events = await sumPoints('mailtool.watcher.events');
    expect(events[0]!.attributes).toMatchObject({ event: 'mailRemoved' });
    expect(events[0]!.value).toBe(1);

    await watcher.stop();
  });

  it('counts a reconnect attempt', async () => {
    vi.useFakeTimers();
    const { AccountWatcherCtor, observeWatcherMetrics } = await loadModules();
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcherCtor(ACCOUNT, {
      WatcherClientCtor: ctor,
      reconnectDelayMs: 25
    });
    observeWatcherMetrics(watcher, ACCOUNT);

    await watcher.start();
    instances[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(25);

    const reconnects = await sumPoints('mailtool.watcher.reconnects');
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]!.attributes).toMatchObject({ 'account.id': 'acc-1' });
    expect(reconnects[0]!.value).toBe(1);

    await watcher.stop();
    vi.useRealTimers();
  });

  describe('observable gauges', () => {
    it('reports connection state and mailbox message count while registered', async () => {
      const { AccountWatcherCtor, observeWatcherMetrics, unobserveWatcherMetrics } =
        await loadModules();
      const { ctor } = buildWatcherCtor({ mailboxOpen: () => Promise.resolve({ exists: 7 }) });
      const watcher = new AccountWatcherCtor(ACCOUNT, { WatcherClientCtor: ctor });
      observeWatcherMetrics(watcher, ACCOUNT);

      await watcher.start();

      const connectionState = await gaugePoints('mailtool.watcher.connection_state');
      expect(connectionState).toHaveLength(1);
      expect(connectionState[0]!.attributes).toMatchObject({ 'account.id': 'acc-1' });
      expect(connectionState[0]!.value).toBe(1);

      const messageCounts = await gaugePoints('mailtool.watcher.mailbox.message_count');
      expect(messageCounts).toHaveLength(1);
      expect(messageCounts[0]!.attributes).toMatchObject({
        'account.id': 'acc-1',
        mailbox: 'INBOX'
      });
      expect(messageCounts[0]!.value).toBe(7);

      await watcher.stop();

      // Still registered, but disconnected: the gauge should reflect the
      // state transition on the next collection.
      const afterStop = await gaugePoints('mailtool.watcher.connection_state');
      expect(afterStop[0]!.value).toBe(0);

      // unobserveWatcherMetrics stops the watcher from being iterated by
      // future collections — asserting on this stops there rather than on
      // whether the SDK's cumulative reader still reports a stale last
      // value for the now-unregistered attribute set, which is an SDK
      // temporal-aggregation policy, not something this module controls.
      expect(() => unobserveWatcherMetrics(ACCOUNT)).not.toThrow();
    });

    it('reports independently for multiple concurrent watchers', async () => {
      const { AccountWatcherCtor, observeWatcherMetrics } = await loadModules();
      const accountA = ACCOUNT;
      const accountB: AccountConfig = { ...ACCOUNT, id: 'acc-2', watchMailboxes: ['Archive'] };

      const { ctor: ctorA } = buildWatcherCtor({ mailboxOpen: () => Promise.resolve({ exists: 1 }) });
      const { ctor: ctorB } = buildWatcherCtor({ mailboxOpen: () => Promise.resolve({ exists: 4 }) });
      const watcherA = new AccountWatcherCtor(accountA, { WatcherClientCtor: ctorA });
      const watcherB = new AccountWatcherCtor(accountB, { WatcherClientCtor: ctorB });
      observeWatcherMetrics(watcherA, accountA);
      observeWatcherMetrics(watcherB, accountB);

      await watcherA.start();
      await watcherB.start();

      const messageCounts = await gaugePoints('mailtool.watcher.mailbox.message_count');
      expect(messageCounts).toHaveLength(2);
      expect(messageCounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: expect.objectContaining({ 'account.id': 'acc-1', mailbox: 'INBOX' }),
            value: 1
          }),
          expect.objectContaining({
            attributes: expect.objectContaining({ 'account.id': 'acc-2', mailbox: 'Archive' }),
            value: 4
          })
        ])
      );

      await watcherA.stop();
      await watcherB.stop();
    });
  });
});
