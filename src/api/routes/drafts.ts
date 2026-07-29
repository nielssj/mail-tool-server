import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';

type CreateDraftRoute = {
  Params: {
    accountId: string;
    mailbox: string;
  };
  Body: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    attachments?: { filename: string; mimeType: string; contentBase64: string }[];
  };
};

export const registerDraftRoutes = <TApp extends FastifyInstance<any, any, any, any>>(
  app: TApp,
  mailboxService: MailboxService
): void => {
  app.post<CreateDraftRoute>('/accounts/:accountId/mailboxes/:mailbox/drafts', {
    schema: {
      params: {
        type: 'object',
        required: ['accountId', 'mailbox'],
        properties: {
          accountId: { type: 'string', minLength: 1 },
          mailbox: { type: 'string', minLength: 1 }
        }
      },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'array', items: { type: 'string', minLength: 1 } },
          cc: { type: 'array', items: { type: 'string', minLength: 1 } },
          bcc: { type: 'array', items: { type: 'string', minLength: 1 } },
          subject: { type: 'string' },
          text: { type: 'string' },
          html: { type: 'string' },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['filename', 'mimeType', 'contentBase64'],
              properties: {
                filename: { type: 'string', minLength: 1 },
                mimeType: { type: 'string', minLength: 1 },
                contentBase64: { type: 'string', minLength: 1 }
              }
            }
          }
        }
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['mailbox'],
          properties: {
            mailbox: { type: 'string' },
            uid: { type: 'integer' },
            uidValidity: { type: 'string' }
          }
        }
      }
    }
  }, async (request) => {
    return mailboxService.createDraft(request.params.accountId, request.params.mailbox, {
      to: request.body.to,
      cc: request.body.cc,
      bcc: request.body.bcc,
      subject: request.body.subject,
      text: request.body.text,
      html: request.body.html,
      attachments: request.body.attachments
    });
  });
};
