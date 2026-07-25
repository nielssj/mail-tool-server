import type { AccountWatcher } from '../imap/watcher.js';
import type { AccountConfig } from '../utils/config/schema.js';
import * as telemetry from './instruments.js';

type WatchedAccount = {
  watcher: AccountWatcher;
  account: AccountConfig;
};

// Gauges are process-global instruments but watchers are per-account
// instances, so a small live registry backs both ObservableGauge callbacks
// below — one gauge covers every registered account rather than one gauge
// per watcher instance. Populated/cleared by observeWatcherMetrics /
// unobserveWatcherMetrics, called by the composition root (server.ts)
// around watcher.start() / watcher.stop().
const liveWatchers = new Map<string, WatchedAccount>();

telemetry.watcherConnectionState.addCallback((result) => {
  for (const { watcher, account } of liveWatchers.values()) {
    result.observe(watcher.isConnected() ? 1 : 0, { 'account.id': account.id });
  }
});

telemetry.watcherMailboxMessageCount.addCallback((result) => {
  for (const { watcher, account } of liveWatchers.values()) {
    for (const mailbox of account.watchMailboxes) {
      const count = watcher.getMailboxMessageCount(mailbox);
      if (count != null) {
        result.observe(count, { 'account.id': account.id, mailbox });
      }
    }
  }
});

/**
 * Wires an AccountWatcher up to record its domain metrics: subscribes to
 * the watcher's existing public events (newMail/flagsChanged/mailRemoved/
 * reconnecting) for counters, and registers it so the two ObservableGauges
 * above can report its current connection state and per-mailbox message
 * counts on collection. Call once per watcher, alongside watcher.start(),
 * at the composition root.
 */
export const observeWatcherMetrics = (watcher: AccountWatcher, account: AccountConfig): void => {
  liveWatchers.set(account.id, { watcher, account });

  watcher.on('newMail', (event) => {
    telemetry.watcherEvents.add(1, {
      'account.id': event.accountId,
      mailbox: event.mailbox,
      event: 'newMail'
    });
    // One newMail event is already exactly one message, so this is a plain
    // +1 rather than a derived delta.
    telemetry.watcherNewMailMessages.add(1, {
      'account.id': event.accountId,
      mailbox: event.mailbox
    });
  });

  watcher.on('flagsChanged', (event) => {
    telemetry.watcherEvents.add(1, {
      'account.id': event.accountId,
      mailbox: event.mailbox,
      event: 'flagsChanged'
    });
  });

  watcher.on('mailRemoved', (event) => {
    telemetry.watcherEvents.add(1, {
      'account.id': event.accountId,
      mailbox: event.mailbox,
      event: 'mailRemoved'
    });
  });

  watcher.on('reconnecting', () => {
    telemetry.watcherReconnects.add(1, { 'account.id': account.id });
  });
};

/**
 * Unregisters a watcher from the observable gauges. Call once per watcher,
 * alongside watcher.stop(), at the composition root.
 */
export const unobserveWatcherMetrics = (account: AccountConfig): void => {
  liveWatchers.delete(account.id);
};
