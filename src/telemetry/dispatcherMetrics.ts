import type { Dispatcher } from '../events/dispatcher.js';
import * as telemetry from './instruments.js';

/**
 * Decorates a Dispatcher to record mailtool.dispatcher.webhook.duration
 * around every handle() call — account.id and event come straight off the
 * DomainEvent argument, so no extra construction-time context is needed.
 */
export const withDispatcherMetrics = (dispatcher: Dispatcher): Dispatcher => ({
  handle: async (event) => {
    const start = performance.now();
    try {
      await dispatcher.handle(event);
      telemetry.dispatcherWebhookDuration.record((performance.now() - start) / 1000, {
        'account.id': event.accountId,
        event: event.event,
        outcome: 'ok'
      });
    } catch (error) {
      telemetry.dispatcherWebhookDuration.record((performance.now() - start) / 1000, {
        'account.id': event.accountId,
        event: event.event,
        outcome: 'error'
      });
      throw error;
    }
  }
});

/**
 * Returns an onAttempt callback (see CreateDispatcherOptions) that records
 * mailtool.dispatcher.webhook.attempts for a fixed account — individual
 * delivery attempts aren't visible from outside a dispatcher (handle()
 * only reports the final outcome after retries), so this is threaded
 * through at construction time instead of wrapping after the fact.
 */
export const createAttemptObserver =
  (accountId: string) =>
  (outcome: 'ok' | 'error'): void => {
    telemetry.dispatcherWebhookAttempts.add(1, { 'account.id': accountId, outcome });
  };
