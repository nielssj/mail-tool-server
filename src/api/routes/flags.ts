import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';
import { isResourceNotFoundError, sendNotFound } from './shared.js';

type SetFlagsRoute = {
  Params: {
    accountId: string;
    mailbox: string;
    uid: number;
  };
  Body: {
    add?: string[];
    remove?: string[];
  };
};

export const registerFlagsRoutes = <TApp extends FastifyInstance<any, any, any, any>>(
  app: TApp,
  mailboxService: MailboxService
): void => {
  app.post<SetFlagsRoute>('/accounts/:accountId/mailboxes/:mailbox/messages/:uid/flags', {
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
      body: {
        type: 'object',
        properties: {
          add: {
            type: 'array',
            items: { type: 'string', minLength: 1 }
          },
          remove: {
            type: 'array',
            items: { type: 'string', minLength: 1 }
          }
        },
        additionalProperties: false
      },
      response: {
        200: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' } }
        },
        404: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } }
        }
      }
    }
  }, async (request, reply) => {
    const add = request.body.add ?? [];
    const remove = request.body.remove ?? [];

    try {
      await mailboxService.setFlags(
        request.params.accountId,
        request.params.mailbox,
        request.params.uid,
        add,
        remove
      );
      return { ok: true };
    } catch (error) {
      if (isResourceNotFoundError(error)) {
        return sendNotFound(reply, (error as Error).message);
      }
      throw error;
    }
  });
};
