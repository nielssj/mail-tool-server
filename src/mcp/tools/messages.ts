import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../../services/mailboxService.js';
import { DEFAULT_BODY_CAP_CHARS, formatMessageBody, formatMessageSummary } from '../format.js';

export type MessageToolsOptions = {
  mailboxService: MailboxService;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const MessageAttachmentSchema = z.object({
  partId: z.string(),
  filename: z.string().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().optional()
});

const MessageSummarySchema = z.object({
  uid: z.number(),
  subject: z.string().optional(),
  from: z.string().optional(),
  date: z.string().optional(),
  flags: z.array(z.string()),
  snippet: z.string()
});

/**
 * Registers `list_messages` (compact, paginated summaries — never full
 * bodies) and `get_message` (envelope + body text bounded to
 * DEFAULT_BODY_CAP_CHARS, with attachment metadata but never bytes). Both
 * are read-only.
 */
export const registerMessageTools = (server: McpServer, options: MessageToolsOptions): void => {
  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description:
        'List messages in a mailbox as compact summaries (uid, subject, from, date, flags, snippet) — never full bodies. Use sinceUid to page incrementally.',
      inputSchema: {
        accountId: z.string().min(1),
        mailbox: z.string().min(1),
        limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
        sinceUid: z.number().int().positive().optional()
      },
      outputSchema: { messages: z.array(MessageSummarySchema) },
      annotations: { readOnlyHint: true }
    },
    async ({ accountId, mailbox, limit, sinceUid }) => {
      const raw = await options.mailboxService.listMessages(accountId, mailbox, {
        limit: limit ?? DEFAULT_LIST_LIMIT,
        sinceUid
      });
      const messages = raw.map(formatMessageSummary);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(messages) }],
        structuredContent: { messages }
      };
    }
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get message',
      description: `Get a single message's envelope and body text. Body is capped at ${DEFAULT_BODY_CAP_CHARS} characters; when truncated, use export_message to retrieve the full content. Attachment metadata only, never bytes.`,
      inputSchema: {
        accountId: z.string().min(1),
        mailbox: z.string().min(1),
        uid: z.number().int().positive()
      },
      outputSchema: {
        uid: z.number(),
        subject: z.string().optional(),
        from: z.string().optional(),
        date: z.string().optional(),
        flags: z.array(z.string()),
        body: z.string(),
        truncated: z.boolean(),
        attachments: z.array(MessageAttachmentSchema),
        hint: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ accountId, mailbox, uid }) => {
      const message = await options.mailboxService.getMessage(accountId, mailbox, uid);
      if (!message) {
        throw new Error(`Message not found: uid ${uid} in mailbox "${mailbox}"`);
      }

      const formatted = formatMessageBody(message);
      const result = {
        ...formatted,
        ...(formatted.truncated
          ? {
              hint: `Body truncated at ${DEFAULT_BODY_CAP_CHARS} characters; call export_message for the full content.`
            }
          : {})
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );
};
