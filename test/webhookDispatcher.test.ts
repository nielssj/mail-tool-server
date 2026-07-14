import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookDispatcher } from '../src/events/dispatchers/webhookDispatcher.js';
import type { DomainEvent } from '../src/events/types.js';

const WEBHOOK_URL = 'https://example.com/webhook';

const NEW_MAIL_EVENT: DomainEvent = {
  event: 'newMail',
  accountId: 'acc-1',
  mailbox: 'INBOX',
  data: { count: 5, previousCount: 4 },
  timestamp: '2024-06-01T00:00:00.000Z'
};

const makeOkResponse = (): Response =>
  new Response(null, { status: 200 }) as Response;

const makeErrorResponse = (status: number): Response =>
  new Response(null, { status }) as Response;

describe('WebhookDispatcher', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('POSTs the event as JSON to the configured URL', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse());

    const dispatcher = new WebhookDispatcher(
      { type: 'webhook', url: WEBHOOK_URL },
      { fetch: mockFetch as typeof globalThis.fetch }
    );

    await dispatcher.handle(NEW_MAIL_EVENT);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(NEW_MAIL_EVENT);
  });

  it('sends the correct payload shape for each event type', async () => {
    const events: DomainEvent[] = [
      NEW_MAIL_EVENT,
      {
        event: 'flagsChanged',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: { uid: 42, flags: ['\\Seen'] },
        timestamp: '2024-06-01T00:00:00.000Z'
      },
      {
        event: 'mailRemoved',
        accountId: 'acc-1',
        mailbox: 'INBOX',
        data: { uid: 42, seq: 1 },
        timestamp: '2024-06-01T00:00:00.000Z'
      }
    ];

    for (const event of events) {
      mockFetch.mockResolvedValueOnce(makeOkResponse());

      const dispatcher = new WebhookDispatcher(
        { type: 'webhook', url: WEBHOOK_URL },
        { fetch: mockFetch as typeof globalThis.fetch }
      );

      await dispatcher.handle(event);

      const [, init] = mockFetch.mock.calls.at(-1) as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual(event);
    }
  });

  it('retries once on a failed first attempt and succeeds on second', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(makeOkResponse());

    const dispatcher = new WebhookDispatcher(
      { type: 'webhook', url: WEBHOOK_URL },
      { fetch: mockFetch as typeof globalThis.fetch }
    );

    await expect(dispatcher.handle(NEW_MAIL_EVENT)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries once on a non-2xx response and succeeds on second', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeOkResponse());

    const dispatcher = new WebhookDispatcher(
      { type: 'webhook', url: WEBHOOK_URL },
      { fetch: mockFetch as typeof globalThis.fetch }
    );

    await expect(dispatcher.handle(NEW_MAIL_EVENT)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after both attempts fail', async () => {
    const networkError = new Error('network error');
    mockFetch
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError);

    const logger = { error: vi.fn() };
    const dispatcher = new WebhookDispatcher(
      { type: 'webhook', url: WEBHOOK_URL },
      { fetch: mockFetch as typeof globalThis.fetch, logger }
    );

    await expect(dispatcher.handle(NEW_MAIL_EVENT)).rejects.toThrow('network error');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('logs an error when all retry attempts are exhausted', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500));

    const logger = { error: vi.fn() };
    const dispatcher = new WebhookDispatcher(
      { type: 'webhook', url: WEBHOOK_URL },
      { fetch: mockFetch as typeof globalThis.fetch, logger }
    );

    await expect(dispatcher.handle(NEW_MAIL_EVENT)).rejects.toThrow('HTTP 500');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  describe('onAttempt', () => {
    it('is called once with "ok" on a first-try success', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse());
      const onAttempt = vi.fn();
      const dispatcher = new WebhookDispatcher(
        { type: 'webhook', url: WEBHOOK_URL },
        { fetch: mockFetch as typeof globalThis.fetch, onAttempt }
      );

      await dispatcher.handle(NEW_MAIL_EVENT);

      expect(onAttempt).toHaveBeenCalledTimes(1);
      expect(onAttempt).toHaveBeenCalledWith('ok');
    });

    it('is called once per attempt — "error" then "ok" — on retry-then-success', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(makeOkResponse());
      const onAttempt = vi.fn();
      const dispatcher = new WebhookDispatcher(
        { type: 'webhook', url: WEBHOOK_URL },
        { fetch: mockFetch as typeof globalThis.fetch, onAttempt }
      );

      await dispatcher.handle(NEW_MAIL_EVENT);

      expect(onAttempt).toHaveBeenCalledTimes(2);
      expect(onAttempt).toHaveBeenNthCalledWith(1, 'error');
      expect(onAttempt).toHaveBeenNthCalledWith(2, 'ok');
    });

    it('is called with "error" for every attempt when retries are exhausted', async () => {
      const networkError = new Error('network error');
      mockFetch.mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);
      const onAttempt = vi.fn();
      const dispatcher = new WebhookDispatcher(
        { type: 'webhook', url: WEBHOOK_URL },
        { fetch: mockFetch as typeof globalThis.fetch, onAttempt }
      );

      await expect(dispatcher.handle(NEW_MAIL_EVENT)).rejects.toThrow('network error');

      expect(onAttempt).toHaveBeenCalledTimes(2);
      expect(onAttempt).toHaveBeenNthCalledWith(1, 'error');
      expect(onAttempt).toHaveBeenNthCalledWith(2, 'error');
    });
  });
});
