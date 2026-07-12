import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../services/mailboxService.js';
import type { AccountConfig } from '../utils/config/schema.js';
import packageJson from '../../package.json' with { type: 'json' };
import { registerAccountTools } from './tools/accounts.js';

export type CreateMcpServerOptions = {
  mailboxService: MailboxService;
  accounts: AccountConfig[];
};

/**
 * Builds a configured McpServer instance with all tools registered.
 * Transport-agnostic — callers are responsible for connecting a transport
 * (stdio, Streamable HTTP, in-memory, etc.).
 */
export const createMcpServer = (options: CreateMcpServerOptions): McpServer => {
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version
  });

  registerAccountTools(server, options);

  return server;
};
