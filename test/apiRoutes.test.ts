import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { isResourceNotFoundError } from '../src/api/routes/shared.js';
import type { MailboxService, MessageDetail } from '../src/services/mailboxService.js';
import type {
  CopyResponseObject,
  FetchMessageObject,
  ListResponse
} from 'imapflow';

const makeListResponse = (path: string): ListResponse => ({
  path,
  pathAsListed: path,
  name: path.split('/').pop() ?? path,
  delimiter: '/',
  parent: [],
  parentPath: '',
  flags: new Set(),
  listed: true,
  subscribed: false
});

const makeFetchMessage = (uid: number): FetchMessageObject => ({
  seq: uid,
  uid,
  flags: new Set(),
  envelope: {
    subject: `Subject ${uid}`
  },
  internalDate: new Date('2024-01-01T00:00:00.000Z'),
  size: 100
});

// Deliberately populates every ImapFlow-native field formatMessageDetails
// is documented to exclude, plus a populated (non-empty) flags Set -- so
// the happy-path test below can prove they never reach the wire, rather
// than merely proving they're absent because the fixture never had them.
const makeMessageDetail = (uid: number): MessageDetail => ({
  seq: uid,
  uid,
  flags: new Set(['\\Seen', '\\Flagged']),
  envelope: {
    subject: `Subject ${uid}`,
    from: [{ name: 'Jane Doe', address: 'jane@example.com' }],
    date: new Date('2024-01-01T00:00:00.000Z')
  },
  internalDate: new Date('2024-01-02T00:00:00.000Z'),
  size: 100,
  source: Buffer.from('raw message bytes'),
  bodyStructure: { part: '1', type: 'text/plain', size: 12 },
  modseq: BigInt(1),
  emailId: 'email-id-1',
  threadId: 'thread-id-1',
  labels: new Set(['\\Important']),
  flagColor: 'yellow',
  bodyParts: new Map([['1', Buffer.from('Body bytes')]]),
  headers: Buffer.from('Subject: x\r\n'),
  id: 'account-scoped-id',
  body: `Body ${uid}`,
  attachments: []
});

const MOVE_RESULT: CopyResponseObject = {
  path: 'INBOX',
  destination: 'Archive',
  uidValidity: BigInt(1)
};

const createMailboxServiceMock = (): MailboxService => {
  const listMailboxes: MailboxService['listMailboxes'] = vi.fn(
    async () => [makeListResponse('INBOX')]
  );
  const listMessages: MailboxService['listMessages'] = vi.fn(
    async () => [makeFetchMessage(1)]
  );
  const getMessage: MailboxService['getMessage'] = vi.fn(
    async () => makeMessageDetail(1)
  );
  const getAttachment: MailboxService['getAttachment'] = vi.fn(async () => false as const);
  const getRawSource: MailboxService['getRawSource'] = vi.fn(async () => false as const);
  const moveMessage: MailboxService['moveMessage'] = vi.fn(async () => MOVE_RESULT);
  const setFlags: MailboxService['setFlags'] = vi.fn(async () => undefined);

  return {
    listMailboxes,
    listMessages,
    getMessage,
    getAttachment,
    getRawSource,
    moveMessage,
    setFlags
  };
};

describe('API routes', () => {
  const mailboxService = createMailboxServiceMock();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      loggerConfig: { env: 'test', level: 'silent' },
      mailboxService
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /accounts/:accountId/mailboxes', () => {
    it('returns mailbox list on happy path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes'
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          path: 'INBOX'
        })
      ]);
    });

    it('returns 404 for unknown account', async () => {
      vi.mocked(mailboxService.listMailboxes).mockRejectedValueOnce(
        new Error('Unknown account id: "missing"')
      );
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/missing/mailboxes'
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /accounts/:accountId/mailboxes/:mailbox/messages', () => {
    it('returns message list on happy path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes/INBOX/messages?limit=10&sinceUid=2'
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          uid: 1
        })
      ]);
      expect(mailboxService.listMessages).toHaveBeenCalledWith('acc-1', 'INBOX', {
        limit: 10,
        sinceUid: 2
      });
    });

    it('returns 404 for unknown mailbox', async () => {
      vi.mocked(mailboxService.listMessages).mockRejectedValueOnce(
        new Error('Unknown mailbox: "Archive"')
      );
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes/Archive/messages'
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid query input', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes/INBOX/messages?limit=0'
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /accounts/:accountId/mailboxes/:mailbox/messages/:uid', () => {
    it('returns the clean projection, excluding every ImapFlow-native leak field', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/1'
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toEqual({
        uid: 1,
        subject: 'Subject 1',
        from: 'Jane Doe <jane@example.com>',
        date: '2024-01-01T00:00:00.000Z',
        flags: ['\\Seen', '\\Flagged'],
        body: 'Body 1',
        attachments: []
      });

      // Belt-and-suspenders: even if a future change accidentally spread
      // extra fields onto the handler's return value, the Fastify response
      // schema (additionalProperties: false) would strip them at
      // serialization time -- assert directly against the raw fixture's
      // leak-prone field names to prove neither path lets them through.
      for (const leaked of [
        'source',
        'bodyStructure',
        'seq',
        'modseq',
        'emailId',
        'threadId',
        'labels',
        'flagColor',
        'bodyParts',
        'headers',
        'id',
        'internalDate',
        'size'
      ]) {
        expect(body).not.toHaveProperty(leaked);
      }
    });

    it('returns 404 when message is missing', async () => {
      vi.mocked(mailboxService.getMessage).mockResolvedValueOnce(false);
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/999'
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid uid input', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/not-a-number'
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /accounts/:accountId/mailboxes/:mailbox/messages/:uid/move', () => {
    it('moves message on happy path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/1/move',
        payload: { destination: 'Archive' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(mailboxService.moveMessage).toHaveBeenCalledWith(
        'acc-1',
        'INBOX',
        1,
        'Archive'
      );
    });

    it('returns 404 for unknown mailbox', async () => {
      vi.mocked(mailboxService.moveMessage).mockRejectedValueOnce(
        new Error('No such mailbox')
      );
      const response = await app.inject({
        method: 'POST',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/1/move',
        payload: { destination: 'Archive' }
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid input', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/1/move',
        payload: {}
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /accounts/:accountId/mailboxes/:mailbox/messages/:uid/flags', () => {
    it('sets flags on happy path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/1/flags',
        payload: { add: ['\\Flagged'], remove: ['\\Seen'] }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(mailboxService.setFlags).toHaveBeenCalledWith(
        'acc-1',
        'INBOX',
        1,
        ['\\Flagged'],
        ['\\Seen']
      );
    });

    it('returns 404 for unknown account', async () => {
      vi.mocked(mailboxService.setFlags).mockRejectedValueOnce(
        new Error('Unknown account id: "missing"')
      );
      const response = await app.inject({
        method: 'POST',
        url: '/accounts/missing/mailboxes/INBOX/messages/1/flags',
        payload: { add: ['\\Flagged'] }
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid input', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts/acc-1/mailboxes/INBOX/messages/1/flags',
        payload: { add: [''] }
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('isResourceNotFoundError', () => {
    it('returns true for unknown account errors', () => {
      expect(isResourceNotFoundError(new Error('Unknown account id: "missing"'))).toBe(
        true
      );
    });

    it('returns true for mailbox missing errors', () => {
      expect(isResourceNotFoundError(new Error('No such mailbox'))).toBe(true);
    });

    it('returns false for non-resource errors and non-Error values', () => {
      expect(isResourceNotFoundError(new Error('Connection reset by peer'))).toBe(false);
      expect(isResourceNotFoundError('Unknown mailbox')).toBe(false);
    });
  });
});
