import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildApp } from './app.js';
import { loadConfig } from './utils/config/load.js';
import { AccountWatcher } from './imap/watcher.js';
import { createDispatcher, subscribeWatcher } from './events/dispatcher.js';
import { createMailboxService, type MailboxService } from './services/mailboxService.js';
import { createMcpServer } from './mcp/server.js';
import type { AccountConfig } from './utils/config/schema.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const httpEnabled = process.env.HTTP_ENABLED !== 'false';
const mcpEnabled = process.env.MCP_ENABLED !== 'false';

type HttpApp = Awaited<ReturnType<typeof buildApp>>;
type McpServerInstance = ReturnType<typeof createMcpServer>;

const startHttpServer = async (
  watchers: AccountWatcher[],
  mailboxService: MailboxService
): Promise<HttpApp | undefined> => {
  if (!httpEnabled) {
    return undefined;
  }

  const app = await buildApp({
    watchers,
    mailboxService,
    // HTTP request logs must stay off stdout whenever the MCP stdio
    // transport shares this process, since stdout is reserved for MCP
    // JSON-RPC framing.
    logDestination: mcpEnabled ? process.stderr : undefined
  });

  await app.listen({ host, port });
  return app;
};

const startMcpServer = async (
  accounts: AccountConfig[],
  mailboxService: MailboxService
): Promise<McpServerInstance | undefined> => {
  if (!mcpEnabled) {
    return undefined;
  }

  const server = createMcpServer({ mailboxService, accounts });
  await server.connect(new StdioServerTransport());
  process.stderr.write('MCP server connected via stdio\n');
  return server;
};

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
  let mcpServer: McpServerInstance | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`Received ${signal}, shutting down...\n`);
    await Promise.all([app?.close(), mcpServer?.close(), ...watchers.map((w) => w.stop())]);
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
    process.stderr.write(`Failed to start server: ${(error as Error).message}\n`);
    process.exit(1);
  }
};

void start();
