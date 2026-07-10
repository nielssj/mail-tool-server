import Fastify from 'fastify';
import { createLogger, type LoggerConfig } from './utils/logger.js';

export type BuildAppOptions = {
  loggerConfig?: LoggerConfig;
};

export const buildApp = (options: BuildAppOptions = {}) => {
  const app = Fastify({
    loggerInstance: createLogger(options.loggerConfig)
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
};
