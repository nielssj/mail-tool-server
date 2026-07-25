import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountWatcher,
  type WatcherClientConstructor
} from '../src/imap/watcher.js';

const ACCOUNT = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: { user: 'user@example.com', pass: 'secret' },
  watchMailboxes: ['INBOX'],
  dispatchers: []
};

type MailboxOpenResult = {
  exists?: number;
  uidNext?: number;
  uidValidity?: bigint;
};

type MockWatcherOverrides = Partial<{
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  mailboxOpen: (path: string) => Promise<MailboxOpenResult>;
  idle: () => Promise<void>;
  fetchAll: (
    range: string,
    query: { uid: true },
    options: { uid: true }
  ) => Promise<Array<{ uid: number }>>;
}>;

const buildWatcherCtor = (overrides: MockWatcherOverrides = {}) => {
  const connect = vi.fn(overrides.connect ?? (() => Promise.resolve()));
  const logout = vi.fn(overrides.logout ?? (() => Promise.resolve()));
  const mailboxOpen = vi.fn(
    overrides.mailboxOpen ?? (() => Promise.resolve({ exists: 0 }))
  );
  const idle = vi.fn(
    overrides.idle ?? (() => new Promise<void>(() => undefined))
  );
  const fetchAll = vi.fn(overrides.fetchAll ?? (() => Promise.resolve([])));
  const instances: MockWatcherClient[] = [];

  class MockWatcherClient extends EventEmitter {
    connect = connect;
    logout = logout;
    mailboxOpen = mailboxOpen;
    idle = idle;
    fetchAll = fetchAll;

    constructor() {
      super();
      instances.push(this);
    }
  }

  return {
    ctor: MockWatcherClient as unknown as WatcherClientConstructor,
    connect,
    logout,
    mailboxOpen,
    idle,
    fetchAll,
    instances
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountWatcher', () => {
  it('emits one newMail event per new message, each carrying uid and count', async () => {
    const { ctor, instances, connect, mailboxOpen, fetchAll } = buildWatcherCtor({
      mailboxOpen: () =>
        Promise.resolve({ exists: 2, uidNext: 3, uidValidity: 1n }),
      fetchAll: () => Promise.resolve([{ uid: 3 }, { uid: 4 }, { uid: 5 }])
    });
    const now = () => new Date('2024-01-02T03:04:05.000Z');
    const watcher = new AccountWatcher(ACCOUNT, {
      WatcherClientCtor: ctor,
      now
    });
    const events: unknown[] = [];

    watcher.on('newMail', (event) => events.push(event));
    await watcher.start();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(mailboxOpen).toHaveBeenCalledWith('INBOX');

    instances[0]?.emit('exists', 5);

    await vi.waitFor(() => {
      if (events.length < 3) {
        throw new Error('waiting for newMail events');
      }
    });

    expect(fetchAll).toHaveBeenCalledWith('3:*', { uid: true }, { uid: true });
    expect(events).toEqual([
      {
        event: 'newMail',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: { uid: 3, count: 5 },
        timestamp: '2024-01-02T03:04:05.000Z'
      },
      {
        event: 'newMail',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: { uid: 4, count: 5 },
        timestamp: '2024-01-02T03:04:05.000Z'
      },
      {
        event: 'newMail',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: { uid: 5, count: 5 },
        timestamp: '2024-01-02T03:04:05.000Z'
      }
    ]);

    await watcher.stop();
  });

  it('retries the UID enrichment fetch once before giving up', async () => {
    let calls = 0;
    const fetchAll = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve([{ uid: 3 }]);
    });
    const { ctor, instances } = buildWatcherCtor({
      mailboxOpen: () =>
        Promise.resolve({ exists: 2, uidNext: 3, uidValidity: 1n }),
      fetchAll
    });
    const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });
    const events: unknown[] = [];
    watcher.on('newMail', (event) => events.push(event));

    await watcher.start();
    instances[0]?.emit('exists', 3);

    await vi.waitFor(() => {
      if (events.length < 1) {
        throw new Error('waiting for newMail event');
      }
    });

    expect(fetchAll).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);

    await watcher.stop();
  });

  it('skips the cycle and logs when enrichment keeps failing, leaving the watermark unadvanced', async () => {
    const fetchAll = vi.fn(
      () => Promise.reject(new Error('down')) as Promise<Array<{ uid: number }>>
    );
    const logger = { warn: vi.fn(), error: vi.fn() };
    const { ctor, instances } = buildWatcherCtor({
      mailboxOpen: () =>
        Promise.resolve({ exists: 2, uidNext: 3, uidValidity: 1n }),
      fetchAll
    });
    const watcher = new AccountWatcher(ACCOUNT, {
      WatcherClientCtor: ctor,
      logger
    });
    const events: unknown[] = [];
    watcher.on('newMail', (event) => events.push(event));

    await watcher.start();
    instances[0]?.emit('exists', 3);

    await vi.waitFor(() => {
      if (fetchAll.mock.calls.length < 2) {
        throw new Error('waiting for retry to exhaust');
      }
    });

    expect(events).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);

    // A later successful fetch re-requests from the same, unadvanced
    // watermark -- nothing was silently skipped.
    fetchAll.mockImplementation(() =>
      Promise.resolve([{ uid: 3 }, { uid: 4 }])
    );
    instances[0]?.emit('exists', 4);

    await vi.waitFor(() => {
      if (events.length < 2) {
        throw new Error('waiting for newMail events');
      }
    });

    expect(fetchAll).toHaveBeenLastCalledWith('3:*', { uid: true }, { uid: true });

    await watcher.stop();
  });

  it(
    'waits for in-flight newMail enrichment before round-robining to the next mailbox',
    async () => {
      let resolveFetch!: (value: Array<{ uid: number }>) => void;
      const fetchPromise = new Promise<Array<{ uid: number }>>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchAll = vi.fn(() => fetchPromise);

      const mailboxOpen = vi.fn((path: string) =>
        path === 'INBOX'
          ? Promise.resolve({ exists: 2, uidNext: 3, uidValidity: 1n })
          : Promise.resolve({ exists: 0, uidNext: 1, uidValidity: 9n })
      );

      const idle = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 5))
      );

      const { ctor, instances } = buildWatcherCtor({
        mailboxOpen,
        fetchAll,
        idle
      });
      const watcher = new AccountWatcher(
        { ...ACCOUNT, watchMailboxes: ['INBOX', 'Archive'] },
        { WatcherClientCtor: ctor }
      );

      await watcher.start();
      instances[0]?.emit('exists', 5);

      // Long enough for the exists handler's microtask chain to reach
      // fetchAll, and for idle()'s 5ms mock delay to resolve and enter the
      // round-robin continuation -- while the enrichment fetch is still
      // deliberately left unresolved.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(fetchAll).toHaveBeenCalledTimes(1);
      expect(mailboxOpen).toHaveBeenCalledTimes(1);
      expect(mailboxOpen).not.toHaveBeenCalledWith('Archive');

      resolveFetch([{ uid: 3 }, { uid: 4 }, { uid: 5 }]);

      await vi.waitFor(() => {
        if (!mailboxOpen.mock.calls.some((call) => call[0] === 'Archive')) {
          throw new Error('waiting for round-robin to Archive');
        }
      });

      await watcher.stop();
    },
    10_000
  );

  it(
    'resets the UID watermark when uidValidity changes between opens of the same mailbox',
    async () => {
      const opensByMailbox: Record<string, number> = {};
      const mailboxOpen = vi.fn((path: string) => {
        opensByMailbox[path] = (opensByMailbox[path] ?? 0) + 1;
        if (path === 'INBOX' && opensByMailbox[path] === 1) {
          return Promise.resolve({ exists: 2, uidNext: 3, uidValidity: 1n });
        }
        if (path === 'INBOX') {
          // Second open: server-side rebuild changed uidValidity, and
          // uidNext along with it -- previously-seen UIDs are meaningless.
          return Promise.resolve({ exists: 1, uidNext: 50, uidValidity: 2n });
        }
        return Promise.resolve({ exists: 0, uidNext: 1, uidValidity: 9n });
      });
      const fetchAll = vi.fn(() => Promise.resolve([{ uid: 50 }]));

      let idleCalls = 0;
      const idle = vi.fn(() => {
        idleCalls += 1;
        if (idleCalls <= 2) {
          return new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        // Parks the watcher idling on INBOX's second open indefinitely, so
        // there's a stable window to assert against.
        return new Promise<void>(() => undefined);
      });

      const { ctor, instances } = buildWatcherCtor({
        mailboxOpen,
        fetchAll,
        idle
      });
      const watcher = new AccountWatcher(
        { ...ACCOUNT, watchMailboxes: ['INBOX', 'Archive'] },
        { WatcherClientCtor: ctor }
      );
      const events: unknown[] = [];
      watcher.on('newMail', (event) => events.push(event));

      await watcher.start();

      await vi.waitFor(
        () => {
          if ((opensByMailbox['INBOX'] ?? 0) < 2) {
            throw new Error('waiting for INBOX to be reopened');
          }
        },
        { timeout: 5000 }
      );

      instances[0]?.emit('exists', 2);

      await vi.waitFor(() => {
        if (events.length < 1) {
          throw new Error('waiting for newMail event');
        }
      });

      // uidNext was reset to 50 on reopen, so the watermark is 49, not the
      // stale 2 from the first open -- proves the reset, not a leftover
      // range from before uidValidity changed.
      expect(fetchAll).toHaveBeenCalledWith('50:*', { uid: true }, { uid: true });

      await watcher.stop();
    },
    10_000
  );

  it('emits flagsChanged with the updated flags payload', async () => {
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, {
      WatcherClientCtor: ctor,
      now: () => new Date('2024-01-02T03:04:05.000Z')
    });
    const events: unknown[] = [];

    watcher.on('flagsChanged', (event) => events.push(event));
    await watcher.start();

    instances[0]?.emit('flags', {
      uid: 42,
      flags: new Set(['\\Seen', '\\Flagged'])
    });

    expect(events).toEqual([
      {
        event: 'flagsChanged',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: {
          uid: 42,
          flags: ['\\Seen', '\\Flagged']
        },
        timestamp: '2024-01-02T03:04:05.000Z'
      }
    ]);

    await watcher.stop();
  });

  it('emits mailRemoved when an expunge event is received', async () => {
    const { ctor, instances } = buildWatcherCtor({
      mailboxOpen: () => Promise.resolve({ exists: 3 })
    });
    const watcher = new AccountWatcher(ACCOUNT, {
      WatcherClientCtor: ctor,
      now: () => new Date('2024-01-02T03:04:05.000Z')
    });
    const events: unknown[] = [];

    watcher.on('mailRemoved', (event) => events.push(event));
    await watcher.start();

    instances[0]?.emit('expunge', {
      uid: 15,
      seq: 2
    });

    expect(events).toEqual([
      {
        event: 'mailRemoved',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: {
          uid: 15,
          seq: 2
        },
        timestamp: '2024-01-02T03:04:05.000Z'
      }
    ]);

    await watcher.stop();
  });

  it('reconnects when the watcher connection closes', async () => {
    vi.useFakeTimers();

    const { ctor, connect, instances } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, {
      WatcherClientCtor: ctor,
      reconnectDelayMs: 25
    });

    await watcher.start();
    expect(instances).toHaveLength(1);

    instances[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(25);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(2);

    await watcher.stop();
  });

  it('emits "reconnecting" once per reconnect attempt', async () => {
    vi.useFakeTimers();

    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, {
      WatcherClientCtor: ctor,
      reconnectDelayMs: 25
    });
    const reconnecting = vi.fn();
    watcher.on('reconnecting', reconnecting);

    await watcher.start();
    instances[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(25);

    expect(reconnecting).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  describe('isConnected', () => {
    it('is false before start() and true once connected', async () => {
      const { ctor } = buildWatcherCtor();
      const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });

      expect(watcher.isConnected()).toBe(false);
      await watcher.start();
      expect(watcher.isConnected()).toBe(true);

      await watcher.stop();
      expect(watcher.isConnected()).toBe(false);
    });
  });

  describe('getMailboxMessageCount', () => {
    it('returns undefined before start(), then the last-known count', async () => {
      const { ctor, instances } = buildWatcherCtor({
        mailboxOpen: () => Promise.resolve({ exists: 2 })
      });
      const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });

      expect(watcher.getMailboxMessageCount('INBOX')).toBeUndefined();
      await watcher.start();
      expect(watcher.getMailboxMessageCount('INBOX')).toBe(2);

      instances[0]?.emit('exists', 5);
      expect(watcher.getMailboxMessageCount('INBOX')).toBe(5);

      await watcher.stop();
      expect(watcher.getMailboxMessageCount('INBOX')).toBeUndefined();
    });
  });
});
