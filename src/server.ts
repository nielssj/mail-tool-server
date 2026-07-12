import type { Server as HttpServer } from 'node:http';
import { buildApp } from './app.js';
import { loadConfig } from './utils/config/load.js';
import { createLogger } from './utils/logger.js';
import { AccountWatcher } from './imap/watcher.js';
import { createDispatcher, subscribeWatcher } from './events/dispatcher.js';
import { createMailboxService, type MailboxService } from './services/mailboxService.js';
import { createMcpHttpServer } from './mcp/httpServer.js';
import type { AccountConfig } from './utils/config/schema.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const mcpPort = Number(process.env.MCP_PORT ?? 3001);
const httpEnabled = process.env.HTTP_ENABLED !== 'false';
const mcpEnabled = process.env.MCP_ENABLED !== 'false';

const logger = createLogger();

type HttpApp = Awaited<ReturnType<typeof buildApp>>;

const startHttpServer = async (
  watchers: AccountWatcher[],
  mailboxService: MailboxService
): Promise<HttpApp | undefined> => {
  if (!httpEnabled) {
    return undefined;
  }

  const app = await buildApp({ watchers, mailboxService });
  await app.listen({ host, port });
  return app;
};

const startMcpServer = async (
  accounts: AccountConfig[],
  mailboxService: MailboxService
): Promise<HttpServer | undefined> => {
  if (!mcpEnabled) {
    return undefined;
  }

  const server = createMcpHttpServer({ mailboxService, accounts });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(mcpPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info(`MCP server listening at http://${host}:${mcpPort}/mcp`);
  return server;
};

const closeMcpServer = (server: HttpServer): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

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

  let app: HttpApp | undefined;
  let mcpServer: HttpServer | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await Promise.all([
      app?.close(),
      mcpServer ? closeMcpServer(mcpServer) : undefined,
      ...watchers.map((w) => w.stop())
    ]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await Promise.all(watchers.map((w) => w.start()));
    [app, mcpServer] = await Promise.all([
      startHttpServer(watchers, mailboxService),
      startMcpServer(config, mailboxService)
    ]);
  } catch (error) {
    logger.error(error, 'Failed to start server');
    process.exit(1);
  }
};

void start();
