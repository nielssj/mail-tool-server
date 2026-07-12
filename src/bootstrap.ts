import { AccountWatcher } from './imap/watcher.js';
import { createDispatcher, subscribeWatcher } from './events/dispatcher.js';
import { createMailboxService, type MailboxService } from './services/mailboxService.js';
import type { AccountConfig } from './utils/config/schema.js';

export type Services = {
  mailboxService: MailboxService;
  watchers: AccountWatcher[];
};

/**
 * Builds the shared services (mailbox service + IMAP watchers, with
 * dispatchers wired up) from a loaded config. Used by both the HTTP
 * entrypoint (server.ts) and the MCP entrypoint (mcp-server.ts) so the
 * construction logic lives in exactly one place.
 */
export const buildServices = (config: AccountConfig[]): Services => {
  const watchers = config.map((account) => new AccountWatcher(account));
  const mailboxService = createMailboxService(config);

  for (let i = 0; i < config.length; i++) {
    const account = config[i]!;
    const watcher = watchers[i]!;
    const dispatchers = account.dispatchers.map((d) => createDispatcher(d));
    subscribeWatcher(watcher, dispatchers);
  }

  return { mailboxService, watchers };
};
