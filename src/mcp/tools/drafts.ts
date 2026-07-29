import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../../services/mailboxService.js';
import { withToolErrors } from '../errors.js';

export type DraftToolsOptions = {
  mailboxService: MailboxService;
};

const DraftAttachmentSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1).describe('Base64-encoded attachment bytes.')
});

type CreateDraftArgs = {
  accountId: string;
  mailbox: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; mimeType: string; contentBase64: string }[];
};

/**
 * Registers `create_draft`: composes an RFC822 message from structured
 * fields and saves it into a mailbox via IMAP APPEND with the \Draft flag.
 * Mutating, but additive rather than destructive — no existing message is
 * touched, so it carries no destructiveHint. Rejected for accounts
 * configured readOnly, same as move_message/set_flags.
 */
export const registerDraftTools = (server: McpServer, options: DraftToolsOptions): void => {
  server.registerTool(
    'create_draft',
    {
      title: 'Create draft',
      description:
        'Compose a draft email (to/cc/bcc, subject, text and/or html body, optional attachments) and save it into a mailbox — typically the account\'s Drafts folder, found via list_mailboxes\' specialUse. Does not send the message.',
      inputSchema: {
        accountId: z.string().min(1).describe('Account id, from list_accounts.'),
        mailbox: z
          .string()
          .min(1)
          .describe('Mailbox path to save the draft into, e.g. "Drafts" (from list_mailboxes).'),
        to: z.array(z.string().min(1)).optional().describe('Recipient addresses, e.g. "Jane Doe <jane@example.com>".'),
        cc: z.array(z.string().min(1)).optional(),
        bcc: z.array(z.string().min(1)).optional(),
        subject: z.string().optional(),
        text: z.string().optional().describe('Plain-text body.'),
        html: z.string().optional().describe('HTML body.'),
        attachments: z.array(DraftAttachmentSchema).optional()
      },
      outputSchema: {
        mailbox: z.string(),
        uid: z.number().optional(),
        uidValidity: z.string().optional()
      }
    },
    withToolErrors(
      async ({ accountId, mailbox, to, cc, bcc, subject, text, html, attachments }: CreateDraftArgs) => {
        const result = await options.mailboxService.createDraft(accountId, mailbox, {
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          attachments
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved draft to "${result.mailbox}"${result.uid != null ? ` (uid ${result.uid})` : ''}.`
            }
          ],
          structuredContent: result
        };
      }
    )
  );
};
