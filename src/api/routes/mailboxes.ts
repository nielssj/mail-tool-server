import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';
import { isResourceNotFoundError, sendNotFound } from './shared.js';

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
        },
        404: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return await mailboxService.listMailboxes(request.params.accountId);
    } catch (error) {
      if (isResourceNotFoundError(error)) {
        return sendNotFound(reply, (error as Error).message);
      }
      throw error;
    }
  });
};
