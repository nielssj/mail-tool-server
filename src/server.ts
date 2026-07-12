import { buildApp } from './app.js';
import { loadConfig } from './utils/config/load.js';
import { buildServices } from './bootstrap.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const start = async (): Promise<void> => {
  const config = loadConfig();

  const { mailboxService, watchers } = buildServices(config);

  const app = await buildApp({ watchers, mailboxService });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await Promise.all(watchers.map((w) => w.start()));
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error, 'Failed to start server');
    process.exit(1);
  }
};

void start();
