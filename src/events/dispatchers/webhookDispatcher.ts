import type { WebhookDispatcherConfig } from '../../utils/config/schema.js';
import type { Dispatcher, DispatcherLogger, CreateDispatcherOptions } from '../dispatcher.js';
import type { DomainEvent } from '../types.js';

const MAX_ATTEMPTS = 2;

export class WebhookDispatcher implements Dispatcher {
  private readonly url: string;

  private readonly fetchFn: typeof globalThis.fetch;

  private readonly logger?: DispatcherLogger;

  private readonly onAttempt?: (outcome: 'ok' | 'error') => void;

  constructor(config: WebhookDispatcherConfig, options: CreateDispatcherOptions = {}) {
    this.url = config.url;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.logger = options.logger;
    this.onAttempt = options.onAttempt;
  }

  async handle(event: DomainEvent): Promise<void> {
    await this.postWithRetry(event, MAX_ATTEMPTS);
  }

  private async postWithRetry(event: DomainEvent, attemptsLeft: number): Promise<void> {
    try {
      const response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        throw new Error(`Webhook returned HTTP ${response.status}`);
      }
      this.onAttempt?.('ok');
    } catch (error) {
      this.onAttempt?.('error');
      if (attemptsLeft > 1) {
        await this.postWithRetry(event, attemptsLeft - 1);
        return;
      }

      this.logger?.error(error, `Webhook POST to "${this.url}" failed after retries`);
      throw error;
    }
  }
}
