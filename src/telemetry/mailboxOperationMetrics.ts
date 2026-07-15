import type { AccountConfig } from '../utils/config/schema.js';
import type { MailboxService } from '../services/mailboxService.js';
import * as telemetry from './instruments.js';

export type MailboxOperationOutcome =
  | 'success'
  | 'not_found'
  | 'read_only'
  | 'imap_connection_error'
  | 'error';

/**
 * Mirrors api/routes/shared.ts's isResourceNotFoundError message
 * vocabulary. Errors are matched by `.name` rather than `instanceof` (both
 * ReadOnlyAccountError and ImapConnectionError set `this.name` in their
 * constructors) so this module doesn't need to import mailboxService.ts's
 * error classes at all — it only ever sees a plain MailboxService object.
 */
const isNotFoundMessage = (message: string): boolean =>
  /unknown account id|unknown mailbox|mailbox.*not found|no such mailbox/i.test(message);

const classifyOutcome = (error: unknown): MailboxOperationOutcome => {
  if (error instanceof Error) {
    if (error.name === 'ReadOnlyAccountError') {
      return 'read_only';
    }
    if (error.name === 'ImapConnectionError') {
      return 'imap_connection_error';
    }
    if (isNotFoundMessage(error.message)) {
      return 'not_found';
    }
  }
  return 'error';
};

// Every MailboxService method takes accountId as its first argument, which
// is what makes one generic wrapper possible here instead of one per method.
type MailboxOperation = (accountId: string, ...rest: never[]) => Promise<unknown>;

const instrumentOperation = <F extends MailboxOperation>(
  operation: string,
  knownAccountIds: ReadonlySet<string>,
  fn: F
): F =>
  (async (accountId: string, ...rest: unknown[]) => {
    const start = performance.now();
    // Bounded label: an accountId outside the configured set is tagged
    // "unknown" rather than echoed as-is, since HTTP/MCP callers can pass
    // arbitrary strings and unbounded attribute values would blow up
    // cardinality in whatever backend collects these metrics (see
    // docs/proposal/otel-metrics-proposal.md).
    const accountLabel = knownAccountIds.has(accountId) ? accountId : 'unknown';

    try {
      const result = await fn(accountId, ...(rest as never[]));
      telemetry.mailboxOperationDuration.record((performance.now() - start) / 1000, {
        'account.id': accountLabel,
        operation,
        outcome: result === false ? 'not_found' : 'success'
      });
      return result;
    } catch (error) {
      telemetry.mailboxOperationDuration.record((performance.now() - start) / 1000, {
        'account.id': accountLabel,
        operation,
        outcome: classifyOutcome(error)
      });
      throw error;
    }
  }) as unknown as F;

/**
 * Decorates a MailboxService to record mailtool.mailbox.operation.duration
 * around every call, without mailboxService.ts itself carrying any
 * telemetry awareness. Intended to be applied once at the composition root
 * (server.ts): `withMailboxOperationMetrics(createMailboxService(accounts), accounts)`.
 */
export const withMailboxOperationMetrics = (
  service: MailboxService,
  accounts: AccountConfig[]
): MailboxService => {
  const knownAccountIds = new Set(accounts.map((a) => a.id));

  return {
    listMailboxes: instrumentOperation('list_mailboxes', knownAccountIds, service.listMailboxes),
    listMessages: instrumentOperation('list_messages', knownAccountIds, service.listMessages),
    getMessage: instrumentOperation('get_message', knownAccountIds, service.getMessage),
    getAttachment: instrumentOperation('get_attachment', knownAccountIds, service.getAttachment),
    getRawSource: instrumentOperation('get_raw_source', knownAccountIds, service.getRawSource),
    moveMessage: instrumentOperation('move_message', knownAccountIds, service.moveMessage),
    setFlags: instrumentOperation('set_flags', knownAccountIds, service.setFlags)
  };
};
