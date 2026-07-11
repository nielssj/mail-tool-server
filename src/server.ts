import { buildApp } from './app.js';
import { loadConfig } from './utils/config/load.js';
import { AccountWatcher } from './imap/watcher.js';
import { createDispatcher, subscribeWatcher } from './events/dispatcher.js';
import { createMailboxService } from './services/mailboxService.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const start = async (): Promise<void> => {
  const config = loadConfig();

  const watchers = config.map((account) => new AccountWatcher(account));
  const mailboxService = createMailboxService(config);

  for (let i = 0; i < config.length; i++) {
    const account = config[i]!;
    const watcher = watchers[i]!;
    const dispatchers = account.dispatchers.map((d) => createDispatcher(d));
    subscribeWatcher(watcher, dispatchers);
  }

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
