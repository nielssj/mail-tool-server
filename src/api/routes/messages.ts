import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';
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
        200: {
          type: 'array',
          items: { type: 'object', additionalProperties: true }
        }
      }
    }
  }, async (request) => {
    return mailboxService.listMessages(
      request.params.accountId,
      request.params.mailbox,
      request.query
    );
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
        200: { type: 'object', additionalProperties: true }
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
    return message;
  });
};
