import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ImapConnectionError } from '../imap/clientFactory.js';
import { NotFoundError, isResourceNotFoundError } from './routes/shared.js';

export const errorHandler = (
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply
): void => {
  if (error.validation != null) {
    void reply.code(400).send({
      error: { message: error.message, code: 'VALIDATION_ERROR' }
    });
    return;
  }

  if (error instanceof NotFoundError || isResourceNotFoundError(error)) {
    void reply.code(404).send({
      error: { message: error.message, code: 'NOT_FOUND' }
    });
    return;
  }

  if (error instanceof ImapConnectionError) {
    void reply.code(503).send({
      error: { message: error.message, code: 'IMAP_CONNECTION_ERROR' }
    });
    return;
  }

  void reply.code(500).send({
    error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
  });
};
