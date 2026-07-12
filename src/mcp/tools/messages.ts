import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../../services/mailboxService.js';
import { DEFAULT_BODY_CAP_CHARS, formatMessageBody, formatMessageSummary } from '../format.js';
import { NotFoundError, withToolErrors } from '../errors.js';

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

type ListMessagesArgs = {
  accountId: string;
  mailbox: string;
  limit?: number;
  sinceUid?: number;
};

type GetMessageArgs = {
  accountId: string;
  mailbox: string;
  uid: number;
};

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
    withToolErrors(async ({ accountId, mailbox, limit, sinceUid }: ListMessagesArgs) => {
      const raw = await options.mailboxService.listMessages(accountId, mailbox, {
        limit: limit ?? DEFAULT_LIST_LIMIT,
        sinceUid
      });
      const messages = raw.map(formatMessageSummary);

      return {
        content: [
          { type: 'text' as const, text: `Found ${messages.length} message(s) in "${mailbox}".` }
        ],
        structuredContent: { messages }
      };
    })
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
    withToolErrors(async ({ accountId, mailbox, uid }: GetMessageArgs) => {
      const message = await options.mailboxService.getMessage(accountId, mailbox, uid);
      if (!message) {
        throw new NotFoundError(`Message not found: uid ${uid} in mailbox "${mailbox}"`);
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

      const summary = [
        `Subject: "${result.subject ?? '(no subject)'}" from ${result.from ?? '(unknown sender)'}.`,
        `Body ${result.truncated ? `truncated at ${DEFAULT_BODY_CAP_CHARS} characters` : `(${result.body.length} chars)`}.`,
        `${result.attachments.length} attachment(s).`
      ].join(' ');

      return {
        content: [{ type: 'text' as const, text: summary }],
        structuredContent: result
      };
    })
  );
};
