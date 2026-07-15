import type { AccountService } from '../services/accountService.js';
import * as telemetry from './instruments.js';

// Every AccountService method takes no per-call identity to validate
// (unlike mailboxService's accountId) — operations here act on the whole
// configured account list, not one account — so the wrapper is simpler:
// no bounded-label resolution needed, just time + classify.
type AccountOperation = (...args: never[]) => Promise<unknown>;

const instrumentOperation = <F extends AccountOperation>(operation: string, fn: F): F =>
  (async (...args: unknown[]) => {
    const start = performance.now();
    try {
      const result = await fn(...(args as never[]));
      telemetry.accountOperationDuration.record((performance.now() - start) / 1000, {
        operation,
        outcome: 'success'
      });
      return result;
    } catch (error) {
      telemetry.accountOperationDuration.record((performance.now() - start) / 1000, {
        operation,
        outcome: 'error'
      });
      throw error;
    }
  }) as unknown as F;

/**
 * Decorates an AccountService to record mailtool.account.operation.duration
 * around every call, without accountService.ts itself carrying any
 * telemetry awareness — same pattern as withMailboxOperationMetrics.
 */
export const withAccountOperationMetrics = (service: AccountService): AccountService => ({
  listAccounts: instrumentOperation('list_accounts', service.listAccounts)
});
