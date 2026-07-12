import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../services/mailboxService.js';
import type { AccountConfig } from '../utils/config/schema.js';
import type { BlobStore } from '../storage/blobStore.js';
import packageJson from '../../package.json' with { type: 'json' };
import { registerAccountTools } from './tools/accounts.js';
import { registerMessageTools } from './tools/messages.js';
import { registerDeliveryTools } from './tools/delivery.js';
import { registerMutationTools } from './tools/mutations.js';

export type CreateMcpServerOptions = {
  mailboxService: MailboxService;
  accounts: AccountConfig[];
  /** Optional — required only for get_attachment/export_message, which
   * throw a clear tool error if called without it configured. */
  blobStore?: BlobStore;
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
  registerMessageTools(server, options);
  registerDeliveryTools(server, options);
  registerMutationTools(server, options);

  return server;
};
