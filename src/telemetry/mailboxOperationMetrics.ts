import type { AccountConfig } from '../utils/config/schema.js';
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
 * error classes — importing them would create a circular dependency, since
 * mailboxService.ts is the caller of recordMailboxOperation below.
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

/**
 * Wraps a mailboxService operation to record
 * mailtool.mailbox.operation.duration. `resolveAccount` is expected to
 * throw a "not found"-shaped error (see isNotFoundMessage) for an unknown
 * accountId; on that path the metric's account.id attribute is tagged
 * "unknown" rather than echoing arbitrary caller input, which could
 * otherwise blow up attribute cardinality (see docs/otel-metrics-proposal.md).
 */
export const recordMailboxOperation = async <T>(
  operation: string,
  accountId: string,
  resolveAccount: (accountId: string) => AccountConfig,
  fn: (account: AccountConfig) => Promise<T>
): Promise<T> => {
  const start = performance.now();
  const durationSeconds = (): number => (performance.now() - start) / 1000;

  let account: AccountConfig;
  try {
    account = resolveAccount(accountId);
  } catch (error) {
    telemetry.mailboxOperationDuration.record(durationSeconds(), {
      'account.id': 'unknown',
      operation,
      outcome: 'not_found'
    });
    throw error;
  }

  try {
    const result = await fn(account);
    telemetry.mailboxOperationDuration.record(durationSeconds(), {
      'account.id': account.id,
      operation,
      outcome: result === false ? 'not_found' : 'success'
    });
    return result;
  } catch (error) {
    telemetry.mailboxOperationDuration.record(durationSeconds(), {
      'account.id': account.id,
      operation,
      outcome: classifyOutcome(error)
    });
    throw error;
  }
};
