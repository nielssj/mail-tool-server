import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../../services/mailboxService.js';
import { NotFoundError, withToolErrors } from '../errors.js';

export type MutationToolsOptions = {
  mailboxService: MailboxService;
};

type MoveMessageArgs = {
  accountId: string;
  mailbox: string;
  uid: number;
  destination: string;
};

type SetFlagsArgs = {
  accountId: string;
  mailbox: string;
  uid: number;
  add: string[];
  remove: string[];
};

/**
 * Registers the two mutating tools: `move_message` (destructive) and
 * `set_flags` (idempotent). Both reject with a clear tool error — rather
 * than executing — when the target account is configured `readOnly` in
 * config.json; that check lives in mailboxService so the HTTP API respects
 * it too.
 */
export const registerMutationTools = (server: McpServer, options: MutationToolsOptions): void => {
  server.registerTool(
    'move_message',
    {
      title: 'Move message',
      description: 'Move a message to a different mailbox (folder).',
      inputSchema: {
        accountId: z.string().min(1),
        mailbox: z.string().min(1),
        uid: z.number().int().positive(),
        destination: z.string().min(1)
      },
      outputSchema: {
        ok: z.boolean(),
        destination: z.string()
      },
      annotations: { destructiveHint: true }
    },
    withToolErrors(async ({ accountId, mailbox, uid, destination }: MoveMessageArgs) => {
      const moved = await options.mailboxService.moveMessage(accountId, mailbox, uid, destination);
      if (!moved) {
        throw new NotFoundError(`Message not found: uid ${uid} in mailbox "${mailbox}"`);
      }

      const result = { ok: true, destination };
      return {
        content: [{ type: 'text' as const, text: `Moved message ${uid} to "${destination}".` }],
        structuredContent: result
      };
    })
  );

  server.registerTool(
    'set_flags',
    {
      title: 'Set flags',
      description: 'Add and/or remove IMAP flags (e.g. \\Seen, \\Flagged) on a message.',
      inputSchema: {
        accountId: z.string().min(1),
        mailbox: z.string().min(1),
        uid: z.number().int().positive(),
        add: z.array(z.string().min(1)).default([]),
        remove: z.array(z.string().min(1)).default([])
      },
      outputSchema: {
        ok: z.boolean()
      },
      annotations: { idempotentHint: true }
    },
    withToolErrors(async ({ accountId, mailbox, uid, add, remove }: SetFlagsArgs) => {
      await options.mailboxService.setFlags(accountId, mailbox, uid, add, remove);

      const result = { ok: true };
      return {
        content: [{ type: 'text' as const, text: `Updated flags for message ${uid}.` }],
        structuredContent: result
      };
    })
  );
};
