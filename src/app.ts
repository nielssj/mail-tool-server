import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createLogger, type LoggerConfig } from './utils/logger.js';
import type { AccountWatcher } from './imap/watcher.js';
import type { MailboxService } from './services/mailboxService.js';
import { registerApiRoutes } from './api/plugin.js';
import { errorHandler } from './api/errorHandler.js';

export type BuildAppOptions = {
  loggerConfig?: LoggerConfig;
  watchers?: AccountWatcher[];
  mailboxService?: MailboxService;
};

export const buildApp = async (options: BuildAppOptions = {}) => {
  const app = Fastify({
    loggerInstance: createLogger(options.loggerConfig)
  });

  app.setErrorHandler(errorHandler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Mail Tool Server',
        description: 'HTTP API for IMAP mailbox operations',
        version: '1.0.0'
      }
    }
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs'
  });

  app.get('/openapi.json', async (_request, reply) => {
    return reply.send(app.swagger());
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
