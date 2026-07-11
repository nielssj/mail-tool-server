import Fastify from 'fastify';
import { createLogger, type LoggerConfig } from './utils/logger.js';
import type { AccountWatcher } from './imap/watcher.js';
import type { MailboxService } from './services/mailboxService.js';
import { registerApiRoutes } from './api/plugin.js';

export type BuildAppOptions = {
  loggerConfig?: LoggerConfig;
  watchers?: AccountWatcher[];
  mailboxService?: MailboxService;
};

export const buildApp = (options: BuildAppOptions = {}) => {
  const app = Fastify({
    loggerInstance: createLogger(options.loggerConfig)
  });

  if (options.watchers && options.watchers.length > 0) {
    const watchers = options.watchers;
    app.addHook('onClose', async () => {
      await Promise.all(watchers.map((w) => w.stop()));
    });
  }

  app.get('/health', async () => ({ status: 'ok' }));

  if (options.mailboxService) {
    registerApiRoutes(app, options.mailboxService);
  }

  return app;
};
