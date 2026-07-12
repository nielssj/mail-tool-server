import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MailboxService } from '../../services/mailboxService.js';
import { sanitizeFilename, type BlobStore } from '../../storage/blobStore.js';

export type DeliveryToolsOptions = {
  mailboxService: MailboxService;
  blobStore?: BlobStore;
};

const StagedBlobSchema = {
  url: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
  hint: z.string()
};

const requireBlobStore = (blobStore: BlobStore | undefined): BlobStore => {
  if (!blobStore) {
    throw new Error(
      'Object storage is not configured (config.json has no "objectStorage" block); this tool is unavailable.'
    );
  }
  return blobStore;
};

const DOWNLOAD_HINT = 'Download the bytes directly from this URL — it expires at expiresAt.';

/**
 * Registers the two large-payload tools: `get_attachment` and
 * `export_message`. Neither ever inlines bytes into the tool result — both
 * stage content into object storage and return a short-lived pre-signed URL
 * plus metadata. Both are read-only.
 */
export const registerDeliveryTools = (server: McpServer, options: DeliveryToolsOptions): void => {
  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        "Fetch one message attachment's bytes (by uid + attachment part id) and stage them into object storage, returning a short-lived pre-signed download URL. Never returns bytes inline.",
      inputSchema: {
        accountId: z.string().min(1),
        mailbox: z.string().min(1),
        uid: z.number().int().positive(),
        partId: z.string().min(1)
      },
      outputSchema: StagedBlobSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ accountId, mailbox, uid, partId }) => {
      const blobStore = requireBlobStore(options.blobStore);
      const attachment = await options.mailboxService.getAttachment(accountId, mailbox, uid, partId);
      if (!attachment) {
        throw new Error(`Attachment not found: uid ${uid}, part "${partId}" in mailbox "${mailbox}"`);
      }

      const filename = sanitizeFilename(attachment.filename, `attachment-${partId}`);
      const staged = await blobStore.stage({
        body: attachment.content,
        contentType: attachment.mimeType,
        filename
      });

      const result = {
        url: staged.url,
        filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        expiresAt: staged.expiresAt,
        hint: DOWNLOAD_HINT
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );

  server.registerTool(
    'export_message',
    {
      title: 'Export message',
      description:
        'Stage the full raw RFC822 message into object storage and return a short-lived pre-signed download URL — use this when get_message truncated the body. Never returns bytes inline.',
      inputSchema: {
        accountId: z.string().min(1),
        mailbox: z.string().min(1),
        uid: z.number().int().positive()
      },
      outputSchema: StagedBlobSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ accountId, mailbox, uid }) => {
      const blobStore = requireBlobStore(options.blobStore);
      const source = await options.mailboxService.getRawSource(accountId, mailbox, uid);
      if (!source) {
        throw new Error(`Message not found: uid ${uid} in mailbox "${mailbox}"`);
      }

      const filename = sanitizeFilename(undefined, `message-${uid}.eml`);
      const staged = await blobStore.stage({
        body: source,
        contentType: 'message/rfc822',
        filename
      });

      const result = {
        url: staged.url,
        filename,
        mimeType: 'message/rfc822',
        sizeBytes: source.length,
        expiresAt: staged.expiresAt,
        hint: DOWNLOAD_HINT
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );
};
