import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ImapConnectionError } from '../src/imap/clientFactory.js';
import { NotFoundError } from '../src/api/routes/shared.js';
import type { MailboxService } from '../src/services/mailboxService.js';

const createMailboxServiceMock = (): MailboxService => ({
  listMailboxes: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  moveMessage: vi.fn(),
  setFlags: vi.fn()
});

describe('central error handler', () => {
  const mailboxService = createMailboxServiceMock();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({ loggerConfig: { env: 'test' }, mailboxService });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it('maps ImapConnectionError to 503 with IMAP_CONNECTION_ERROR code', async () => {
    vi.mocked(mailboxService.listMailboxes).mockRejectedValueOnce(
      new ImapConnectionError('Failed to connect to IMAP account "acc-1"')
    );
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/acc-1/mailboxes'
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: 'Failed to connect to IMAP account "acc-1"',
        code: 'IMAP_CONNECTION_ERROR'
      }
    });
  });

  it('maps Fastify validation errors to 400 with VALIDATION_ERROR code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/acc-1/mailboxes/INBOX/messages?limit=0'
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { message: string; code: string } }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error.message).toBe('string');
  });

  it('maps NotFoundError to 404 with NOT_FOUND code', async () => {
    vi.mocked(mailboxService.getMessage).mockResolvedValueOnce(false);
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/acc-1/mailboxes/INBOX/messages/999'
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: 'Message not found', code: 'NOT_FOUND' }
    });
  });

  it('maps isResourceNotFoundError-matching error to 404 with NOT_FOUND code', async () => {
    vi.mocked(mailboxService.listMailboxes).mockRejectedValueOnce(
      new Error('Unknown account id: "missing"')
    );
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/missing/mailboxes'
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: 'Unknown account id: "missing"', code: 'NOT_FOUND' }
    });
  });

  it('maps an explicit NotFoundError thrown from a route to 404 with NOT_FOUND code', async () => {
    vi.mocked(mailboxService.moveMessage).mockResolvedValueOnce(false);
    const response = await app.inject({
      method: 'POST',
      url: '/accounts/acc-1/mailboxes/INBOX/messages/1/move',
      payload: { destination: 'Archive' }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: 'Message not found', code: 'NOT_FOUND' }
    });
  });

  it('maps an unknown error to 500 with INTERNAL_ERROR code', async () => {
    vi.mocked(mailboxService.listMailboxes).mockRejectedValueOnce(
      new Error('Unexpected database failure')
    );
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/acc-1/mailboxes'
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' }
    });
  });

  it('does not leak internal error details in 500 responses', async () => {
    vi.mocked(mailboxService.listMailboxes).mockRejectedValueOnce(
      new Error('secret internal detail')
    );
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/acc-1/mailboxes'
    });
    expect(response.statusCode).toBe(500);
    const body = response.json<{ error: { message: string } }>();
    expect(body.error.message).not.toContain('secret internal detail');
  });
});

describe('NotFoundError', () => {
  it('is an instance of Error with name NotFoundError', () => {
    const err = new NotFoundError('Something not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NotFoundError');
    expect(err.message).toBe('Something not found');
  });
});
