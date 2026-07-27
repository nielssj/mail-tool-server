import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';
import { formatMessageDetails, formatMessageListItem } from '../../mcp/format.js';
import { NotFoundError } from './shared.js';

type ListMessagesRoute = {
  Params: {
    accountId: string;
    mailbox: string;
  };
  Querystring: {
    limit?: number;
    sinceUid?: number;
  };
};

type GetMessageRoute = {
  Params: {
    accountId: string;
    mailbox: string;
    uid: number;
  };
};

export const registerMessageRoutes = <TApp extends FastifyInstance<any, any, any, any>>(
  app: TApp,
  mailboxService: MailboxService
): void => {
  app.get<ListMessagesRoute>('/accounts/:accountId/mailboxes/:mailbox/messages', {
    schema: {
      params: {
        type: 'object',
        required: ['accountId', 'mailbox'],
        properties: {
          accountId: { type: 'string', minLength: 1 },
          mailbox: { type: 'string', minLength: 1 }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1 },
          sinceUid: { type: 'integer', minimum: 1 }
        }
      },
      response: {
        // Explicit properties + additionalProperties: false, same
        // reasoning as the single-message route below: enforced at the
        // wire, not just by what the handler returns. Deliberately
        // minimal -- no flags/body/attachments here at all, since this
        // fans out per message in the mailbox; get_message/GET
        // .../messages/:uid is where full per-message detail lives.
        200: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['uid'],
            properties: {
              uid: { type: 'integer' },
              subject: { type: 'string' },
              from: { type: 'string' },
              date: { type: 'string' }
            }
          }
        }
      }
    }
  }, async (request) => {
    const messages = await mailboxService.listMessages(
      request.params.accountId,
      request.params.mailbox,
      request.query
    );
    return messages.map(formatMessageListItem);
  });

  app.get<GetMessageRoute>('/accounts/:accountId/mailboxes/:mailbox/messages/:uid', {
    schema: {
      params: {
        type: 'object',
        required: ['accountId', 'mailbox', 'uid'],
        properties: {
          accountId: { type: 'string', minLength: 1 },
          mailbox: { type: 'string', minLength: 1 },
          uid: { type: 'integer', minimum: 1 }
        }
      },
      response: {
        // Explicit properties + additionalProperties: false so the
        // exclusions in formatMessageDetails (see mcp/format.ts) are
        // enforced by Fastify's response serializer too, not just by
        // what the handler happens to return -- a future accidental
        // `...message` spread here would be stripped at the wire, not
        // silently leaked.
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['uid', 'flags', 'body', 'attachments'],
          properties: {
            uid: { type: 'integer' },
            subject: { type: 'string' },
            from: { type: 'string' },
            date: { type: 'string' },
            flags: { type: 'array', items: { type: 'string' } },
            body: { type: 'string' },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['partId', 'mimeType'],
                properties: {
                  partId: { type: 'string' },
                  filename: { type: 'string' },
                  mimeType: { type: 'string' },
                  sizeBytes: { type: 'integer' }
                }
              }
            }
          }
        }
      }
    }
  }, async (request) => {
    const message = await mailboxService.getMessage(
      request.params.accountId,
      request.params.mailbox,
      request.params.uid
    );
    if (!message) {
      throw new NotFoundError('Message not found');
    }
    return formatMessageDetails(message);
  });
};
