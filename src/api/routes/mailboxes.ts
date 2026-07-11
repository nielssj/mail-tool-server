import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';

type MailboxParams = {
  Params: {
    accountId: string;
  };
};

export const registerMailboxRoutes = <TApp extends FastifyInstance<any, any, any, any>>(
  app: TApp,
  mailboxService: MailboxService
): void => {
  app.get<MailboxParams>('/accounts/:accountId/mailboxes', {
    schema: {
      params: {
        type: 'object',
        required: ['accountId'],
        properties: {
          accountId: { type: 'string', minLength: 1 }
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
    return mailboxService.listMailboxes(request.params.accountId);
  });
};
