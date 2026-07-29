import type { FastifyInstance } from 'fastify';
import type { MailboxService } from '../services/mailboxService.js';
import { registerMailboxRoutes } from './routes/mailboxes.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerMoveRoutes } from './routes/move.js';
import { registerFlagsRoutes } from './routes/flags.js';
import { registerDraftRoutes } from './routes/drafts.js';

export const registerApiRoutes = <TApp extends FastifyInstance<any, any, any, any>>(
  app: TApp,
  mailboxService: MailboxService
): void => {
  registerMailboxRoutes(app, mailboxService);
  registerMessageRoutes(app, mailboxService);
  registerMoveRoutes(app, mailboxService);
  registerFlagsRoutes(app, mailboxService);
  registerDraftRoutes(app, mailboxService);
};
