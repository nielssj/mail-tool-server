import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { MailboxService } from '../src/services/mailboxService.js';

const createMailboxServiceMock = (): MailboxService => ({
  listMailboxes: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
  getMessage: vi.fn(async () => false as const),
  moveMessage: vi.fn(async () => false as const),
  setFlags: vi.fn(async () => undefined)
});

describe('OpenAPI / Swagger', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({
      loggerConfig: { env: 'test' },
      mailboxService: createMailboxServiceMock()
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /openapi.json', () => {
    it('returns a valid OpenAPI 3 document', async () => {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);

      const doc = response.json();

      expect(doc.openapi).toMatch(/^3\./);
      expect(doc.info).toMatchObject({ title: 'Mail Tool Server', version: '1.0.0' });
      expect(typeof doc.paths).toBe('object');
    });

    it('lists all expected route paths', async () => {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      const doc = response.json() as { paths: Record<string, unknown> };
      const paths = Object.keys(doc.paths);

      expect(paths).toContain('/accounts/{accountId}/mailboxes');
      expect(paths).toContain('/accounts/{accountId}/mailboxes/{mailbox}/messages');
      expect(paths).toContain(
        '/accounts/{accountId}/mailboxes/{mailbox}/messages/{uid}'
      );
      expect(paths).toContain(
        '/accounts/{accountId}/mailboxes/{mailbox}/messages/{uid}/move'
      );
      expect(paths).toContain(
        '/accounts/{accountId}/mailboxes/{mailbox}/messages/{uid}/flags'
      );
    });
  });

  describe('GET /docs', () => {
    it('serves the Swagger UI page', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.body).toContain('swagger');
    });
  });
});
