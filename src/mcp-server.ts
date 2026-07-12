import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './utils/config/load.js';
import { buildServices } from './bootstrap.js';
import { createMcpServer } from './mcp/server.js';

// stdout is reserved for MCP JSON-RPC framing over the stdio transport, so
// diagnostics must go to stderr instead.
const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const start = async (): Promise<void> => {
  const config = loadConfig();
  const { mailboxService } = buildServices(config);

  const server = createMcpServer({ mailboxService, accounts: config });
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    log(`Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await server.connect(transport);
    log('MCP server connected via stdio');
  } catch (error) {
    log(`Failed to start MCP server: ${(error as Error).message}`);
    process.exit(1);
  }
};

void start();
