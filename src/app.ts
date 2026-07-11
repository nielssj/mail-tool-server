import Fastify from 'fastify';
import { createLogger, type LoggerConfig } from './utils/logger.js';
import type { AccountWatcher } from './imap/watcher.js';

export type BuildAppOptions = {
  loggerConfig?: LoggerConfig;
  watchers?: AccountWatcher[];
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

  return app;
};
