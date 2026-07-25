import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import {
  createDispatcher,
  subscribeWatcher,
  type Dispatcher
} from '../src/events/dispatcher.js';
import {
  AccountWatcher,
  type WatcherClientConstructor
} from '../src/imap/watcher.js';
import type { DomainEvent } from '../src/events/types.js';

const ACCOUNT = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: { user: 'user@example.com', pass: 'secret' },
  watchMailboxes: ['INBOX'],
  dispatchers: []
};

const buildWatcherCtor = () => {
  const idle = vi.fn(() => new Promise<void>(() => undefined));
  const instances: EventEmitter[] = [];

  class MockWatcherClient extends EventEmitter {
    connect = vi.fn(() => Promise.resolve());
    logout = vi.fn(() => Promise.resolve());
    mailboxOpen = vi.fn(() =>
      Promise.resolve({ exists: 0, uidNext: 1, uidValidity: 1n })
    );
    idle = idle;
    fetchAll = vi.fn(() => Promise.resolve([{ uid: 1 }]));

    constructor() {
      super();
      instances.push(this);
    }
  }

  return {
    ctor: MockWatcherClient as unknown as WatcherClientConstructor,
    instances
  };
};

describe('createDispatcher', () => {
  it('creates a WebhookDispatcher for type "webhook"', () => {
    const dispatcher = createDispatcher({
      type: 'webhook',
      url: 'https://example.com/hook'
    });

    expect(dispatcher).toBeDefined();
    expect(typeof dispatcher.handle).toBe('function');
  });

  it('throws a descriptive error for an unrecognized type', () => {
    expect(() =>
      createDispatcher({ type: 'unknown' } as never)
    ).toThrow('Unrecognized dispatcher type: "unknown"');
  });
});

describe('subscribeWatcher', () => {
  it('fans out all domain events to every registered dispatcher', async () => {
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });

    const received: DomainEvent[] = [];
    const stubDispatcher: Dispatcher = {
      handle: vi.fn(async (event) => {
        received.push(event);
      })
    };

    subscribeWatcher(watcher, [stubDispatcher]);
    await watcher.start();

    const now = new Date('2024-06-01T00:00:00.000Z').toISOString();

    instances[0]?.emit('exists', 3);
    instances[0]?.emit('flags', { uid: 7, flags: new Set(['\\Seen']) });
    instances[0]?.emit('expunge', { uid: 7, seq: 1 });

    // Fan-out is fire-and-forget; flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(stubDispatcher.handle).toHaveBeenCalledTimes(3);
    // newMail's dispatch is a few microtask hops behind flagsChanged/
    // mailRemoved now (it awaits the UID enrichment fetch first), so cross-
    // event-type ordering isn't guaranteed -- assert membership, not order.
    expect(received.map((e) => e.event).sort()).toEqual([
      'flagsChanged',
      'mailRemoved',
      'newMail'
    ]);

    await watcher.stop();
    void now;
  });

  it('fans out to multiple dispatchers independently', async () => {
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });

    const firstHandled: DomainEvent[] = [];
    const secondHandled: DomainEvent[] = [];

    const firstDispatcher: Dispatcher = {
      handle: vi.fn(async (event) => {
        firstHandled.push(event);
      })
    };

    const secondDispatcher: Dispatcher = {
      handle: vi.fn(async (event) => {
        secondHandled.push(event);
      })
    };

    subscribeWatcher(watcher, [firstDispatcher, secondDispatcher]);
    await watcher.start();

    instances[0]?.emit('exists', 1);

    await new Promise((r) => setTimeout(r, 0));

    expect(firstDispatcher.handle).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.handle).toHaveBeenCalledTimes(1);
    expect(firstHandled[0]).toMatchObject({ event: 'newMail' });
    expect(secondHandled[0]).toMatchObject({ event: 'newMail' });

    await watcher.stop();
  });

  it('logs dispatcher errors without propagating them', async () => {
    const { ctor, instances } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });

    const failingDispatcher: Dispatcher = {
      handle: vi.fn(async () => {
        throw new Error('dispatch failed');
      })
    };

    const logger = { error: vi.fn() };
    subscribeWatcher(watcher, [failingDispatcher], logger);
    await watcher.start();

    instances[0]?.emit('exists', 1);

    await new Promise((r) => setTimeout(r, 0));

    expect(failingDispatcher.handle).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('does nothing when the dispatchers array is empty', async () => {
    const { ctor } = buildWatcherCtor();
    const watcher = new AccountWatcher(ACCOUNT, { WatcherClientCtor: ctor });

    expect(() => subscribeWatcher(watcher, [])).not.toThrow();
    await watcher.stop();
  });
});
