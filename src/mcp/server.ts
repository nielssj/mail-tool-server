import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MailboxService } from '../services/mailboxService.js';
import type { AccountConfig } from '../utils/config/schema.js';
import packageJson from '../../package.json' with { type: 'json' };

export type CreateMcpServerOptions = {
  mailboxService: MailboxService;
  accounts: AccountConfig[];
};

/**
 * Builds a configured McpServer instance. Transport-agnostic — callers are
 * responsible for connecting a transport (stdio, in-memory, etc.).
 *
 * No tools are registered yet; tools are added by later tasks in the MCP
 * plan (see docs/mcp-tool-interface-proposal.md). The high-level McpServer
 * only wires up the tools/* request handlers once a tool is registered, so
 * we declare the (empty) tools capability and a `tools/list` handler
 * ourselves via the underlying low-level `Server` so clients can still
 * discover (the currently empty) tool set.
 */
export const createMcpServer = (options: CreateMcpServerOptions): McpServer => {
  // Referenced for future tool registration; unused for now since this task
  // registers no tools.
  void options.mailboxService;
  void options.accounts;

  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version
  });

  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));

  return server;
};
