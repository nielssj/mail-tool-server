import type { Dispatcher } from '../events/dispatcher.js';
import * as telemetry from './instruments.js';

/**
 * Decorates a Dispatcher to record mailtool.dispatcher.webhook.duration
 * around every handle() call — account.id and event come straight off the
 * DomainEvent argument, so no extra construction-time context is needed.
 * Retries are opaque from out here (handle() only reports the final
 * outcome), which is intentional: per-outcome counts are a query over this
 * histogram's count, not a separate attempts counter to keep in sync — if
 * retries make a dispatch pathologically slow, that shows up here too.
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
