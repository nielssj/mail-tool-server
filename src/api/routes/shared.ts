import type { FastifyReply } from 'fastify';

export const isResourceNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unknown account id|unknown mailbox|mailbox.*not found|no such mailbox/i.test(
    error.message
  );
};

export const sendNotFound = (reply: FastifyReply, message: string) =>
  reply.code(404).send({ error: message });
