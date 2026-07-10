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

type MockWatcherOverrides = Partial<{
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  mailboxOpen: (path: string) => Promise<{ exists?: number }>;
  idle: () => Promise<void>;
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
  const instances: MockWatcherClient[] = [];

  class MockWatcherClient extends EventEmitter {
    connect = connect;
    logout = logout;
    mailboxOpen = mailboxOpen;
    idle = idle;

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
    instances
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountWatcher', () => {
  it('emits newMail when exists count increases', async () => {
    const { ctor, instances, connect, mailboxOpen } = buildWatcherCtor({
      mailboxOpen: () => Promise.resolve({ exists: 2 })
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

    expect(events).toEqual([
      {
        event: 'newMail',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: {
          count: 5,
          previousCount: 2
        },
        timestamp: '2024-01-02T03:04:05.000Z'
      }
    ]);

    await watcher.stop();
  });

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
});
