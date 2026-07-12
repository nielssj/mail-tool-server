import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../../services/mailboxService.js';
import type { AccountConfig } from '../../utils/config/schema.js';
import { withToolErrors } from '../errors.js';

export type AccountToolsOptions = {
  mailboxService: MailboxService;
  accounts: AccountConfig[];
};

const AccountSummarySchema = z.object({
  id: z.string(),
  host: z.string(),
  watchMailboxes: z.array(z.string())
});

const MailboxSummarySchema = z.object({
  path: z.string(),
  name: z.string(),
  delimiter: z.string(),
  flags: z.array(z.string()),
  specialUse: z.string().optional()
});

/**
 * Registers the discovery tools: `list_accounts` (config, no service call)
 * and `list_mailboxes` (mailboxService.listMailboxes). Both are read-only.
 */
export const registerAccountTools = (server: McpServer, options: AccountToolsOptions): void => {
  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'List the configured mail accounts available to other tools, by id. Never includes credentials.',
      outputSchema: { accounts: z.array(AccountSummarySchema) },
      annotations: { readOnlyHint: true }
    },
    withToolErrors(async () => {
      const accounts = options.accounts.map((account) => ({
        id: account.id,
        host: account.host,
        watchMailboxes: account.watchMailboxes
      }));

      return {
        content: [{ type: 'text' as const, text: `Found ${accounts.length} account(s).` }],
        structuredContent: { accounts }
      };
    })
  );

  server.registerTool(
    'list_mailboxes',
    {
      title: 'List mailboxes',
      description: 'List the IMAP mailboxes (folders) for an account.',
      inputSchema: { accountId: z.string().min(1) },
      outputSchema: { mailboxes: z.array(MailboxSummarySchema) },
      annotations: { readOnlyHint: true }
    },
    withToolErrors(async ({ accountId }: { accountId: string }) => {
      const list = await options.mailboxService.listMailboxes(accountId);
      const mailboxes = list.map((mailbox) => ({
        path: mailbox.path,
        name: mailbox.name,
        delimiter: mailbox.delimiter,
        flags: Array.from(mailbox.flags),
        specialUse: mailbox.specialUse
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${mailboxes.length} mailbox(es) in account "${accountId}".`
          }
        ],
        structuredContent: { mailboxes }
      };
    })
  );
};
