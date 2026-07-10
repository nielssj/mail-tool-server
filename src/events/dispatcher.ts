import type { DispatcherConfig } from '../utils/config/schema.js';
import type { AccountWatcher } from '../imap/watcher.js';
import type { DomainEvent } from './types.js';
import { WebhookDispatcher } from './dispatchers/webhookDispatcher.js';

export interface Dispatcher {
  handle(event: DomainEvent): Promise<void>;
}

export type DispatcherLogger = {
  error: (...args: unknown[]) => void;
};

export type CreateDispatcherOptions = {
  logger?: DispatcherLogger;
  fetch?: typeof globalThis.fetch;
};

export const createDispatcher = (
  config: DispatcherConfig,
  options: CreateDispatcherOptions = {}
): Dispatcher => {
  switch (config.type) {
    case 'webhook':
      return new WebhookDispatcher(config, options);
    default:
      throw new Error(
        `Unrecognized dispatcher type: "${(config as { type: string }).type}"`
      );
  }
};

const WATCHER_EVENTS = ['newMail', 'flagsChanged', 'mailRemoved'] as const;

export const subscribeWatcher = (
  watcher: AccountWatcher,
  dispatchers: Dispatcher[],
  logger?: DispatcherLogger
): void => {
  if (dispatchers.length === 0) {
    return;
  }

  const fanOut = (event: DomainEvent): void => {
    for (const dispatcher of dispatchers) {
      void dispatcher.handle(event).catch((error) => {
        logger?.error(error, `Dispatcher failed to handle "${event.event}" event`);
      });
    }
  };

  for (const eventName of WATCHER_EVENTS) {
    watcher.on(eventName, fanOut);
  }
};
