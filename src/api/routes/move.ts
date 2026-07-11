import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../../services/mailboxService.js';
import { isResourceNotFoundError, sendNotFound } from './shared.js';

type MoveRoute = {
  Params: {
    accountId: string;
    mailbox: string;
    uid: number;
  };
  Body: {
    destination: string;
  };
};

export const registerMoveRoutes = <TApp extends FastifyInstance<any, any, any, any>>(
  app: TApp,
  mailboxService: MailboxService
): void => {
  app.post<MoveRoute>('/accounts/:accountId/mailboxes/:mailbox/messages/:uid/move', {
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
        required: ['destination'],
        properties: {
          destination: { type: 'string', minLength: 1 }
        }
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
    try {
      const moved = await mailboxService.moveMessage(
        request.params.accountId,
        request.params.mailbox,
        request.params.uid,
        request.body.destination
      );

      if (!moved) {
        return sendNotFound(reply, 'Message not found');
      }

      return { ok: true };
    } catch (error) {
      if (isResourceNotFoundError(error)) {
        return sendNotFound(reply, (error as Error).message);
      }
      throw error;
    }
  });
};
