import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import {
  createMailboxService,
  type MailboxClientConstructor,
  type DownloadedPart
} from '../src/services/mailboxService.js';
import { ImapConnectionError } from '../src/imap/clientFactory.js';
import type { ListResponse, FetchMessageObject, MessageStructureObject } from 'imapflow';

const makeDownload = (text: string): DownloadedPart => ({
  meta: { contentType: 'text/plain' },
  content: Readable.from([Buffer.from(text, 'utf8')])
});

const ACCOUNT = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: { user: 'user@example.com', pass: 'secret' },
  watchMailboxes: ['INBOX'],
  dispatchers: []
};

const ACCOUNTS = [ACCOUNT];

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
  flags: new Set(['\\Seen']),
  envelope: {
    subject: `Subject ${uid}`,
    from: [{ address: 'sender@example.com' }]
  },
  internalDate: new Date('2024-01-01'),
  size: 1024
});

type MockClientOverrides = Partial<{
  list: () => Promise<ListResponse[]>;
  mailboxOpen: () => Promise<object>;
  fetchAll: () => Promise<FetchMessageObject[]>;
  fetchOne: () => Promise<FetchMessageObject | false>;
  download: () => Promise<DownloadedPart>;
  messageMove: () => Promise<object | false>;
  messageFlagsAdd: () => Promise<boolean>;
  messageFlagsRemove: () => Promise<boolean>;
  connect: () => Promise<void>;
  logout: () => Promise<void>;
}>;

const buildMockCtor = (overrides: MockClientOverrides = {}) => {
  const connect = vi.fn(overrides.connect ?? (() => Promise.resolve()));
  const logout = vi.fn(overrides.logout ?? (() => Promise.resolve()));
  const list = vi.fn(overrides.list ?? (() => Promise.resolve([])));
  const mailboxOpen = vi.fn(
    overrides.mailboxOpen ?? (() => Promise.resolve({}))
  );
  const fetchAll = vi.fn(overrides.fetchAll ?? (() => Promise.resolve([])));
  const fetchOne = vi.fn(
    overrides.fetchOne ?? (() => Promise.resolve(false as const))
  );
  const download = vi.fn(
    overrides.download ?? (() => Promise.resolve(makeDownload('')))
  );
  const messageMove = vi.fn(
    overrides.messageMove ?? (() => Promise.resolve(false as const))
  );
  const messageFlagsAdd = vi.fn(
    overrides.messageFlagsAdd ?? (() => Promise.resolve(true))
  );
  const messageFlagsRemove = vi.fn(
    overrides.messageFlagsRemove ?? (() => Promise.resolve(true))
  );

  class MockMailboxClient {
    connect = connect;
    logout = logout;
    list = list;
    mailboxOpen = mailboxOpen;
    fetchAll = fetchAll;
    fetchOne = fetchOne;
    download = download;
    messageMove = messageMove;
    messageFlagsAdd = messageFlagsAdd;
    messageFlagsRemove = messageFlagsRemove;
  }

  const ctor = MockMailboxClient as unknown as MailboxClientConstructor;

  return {
    ctor,
    connect,
    logout,
    list,
    mailboxOpen,
    fetchAll,
    fetchOne,
    download,
    messageMove,
    messageFlagsAdd,
    messageFlagsRemove
  };
};

describe('createMailboxService', () => {
  describe('listMailboxes', () => {
    it('connects, calls list(), then logs out', async () => {
      const mailboxes = [makeListResponse('INBOX'), makeListResponse('Sent')];
      const { ctor, connect, logout, list } = buildMockCtor({
        list: () => Promise.resolve(mailboxes)
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.listMailboxes('acc-1');

      expect(connect).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      expect(logout).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mailboxes);
    });

    it('throws for unknown accountId', async () => {
      const { ctor } = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await expect(service.listMailboxes('no-such-account')).rejects.toThrow(
        /Unknown account id/
      );
    });

    it('wraps connection errors as ImapConnectionError', async () => {
      const { ctor } = buildMockCtor({
        connect: () => Promise.reject(new Error('socket timeout'))
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await expect(service.listMailboxes('acc-1')).rejects.toBeInstanceOf(
        ImapConnectionError
      );
    });

    it('closes connection even when list() throws', async () => {
      const { ctor, logout } = buildMockCtor({
        list: () => Promise.reject(new Error('list failed'))
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await expect(service.listMailboxes('acc-1')).rejects.toThrow('list failed');
      expect(logout).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMessages', () => {
    it('opens mailbox, fetches all messages, then logs out', async () => {
      const messages = [makeFetchMessage(1), makeFetchMessage(2)];
      const { ctor, connect, logout, mailboxOpen, fetchAll } = buildMockCtor({
        fetchAll: () => Promise.resolve(messages)
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.listMessages('acc-1', 'INBOX');

      expect(connect).toHaveBeenCalledTimes(1);
      expect(mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(fetchAll).toHaveBeenCalledWith(
        '1:*',
        expect.objectContaining({
          uid: true,
          bodyParts: [{ key: '1', maxLength: expect.any(Number) }]
        }),
        { uid: true }
      );
      expect(logout).toHaveBeenCalledTimes(1);
      expect(result).toEqual(messages);
    });

    it('uses sinceUid range when provided', async () => {
      const { ctor, fetchAll } = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await service.listMessages('acc-1', 'INBOX', { sinceUid: 42 });
      expect(fetchAll).toHaveBeenCalledWith('42:*', expect.anything(), { uid: true });
    });

    it('applies limit by returning the last N messages', async () => {
      const messages = [1, 2, 3, 4, 5].map(makeFetchMessage);
      const { ctor } = buildMockCtor({
        fetchAll: () => Promise.resolve(messages)
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.listMessages('acc-1', 'INBOX', { limit: 3 });
      expect(result).toHaveLength(3);
      expect(result).toEqual(messages.slice(-3));
    });

    it('returns all messages when count is within limit', async () => {
      const messages = [makeFetchMessage(1), makeFetchMessage(2)];
      const { ctor } = buildMockCtor({
        fetchAll: () => Promise.resolve(messages)
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.listMessages('acc-1', 'INBOX', { limit: 10 });
      expect(result).toHaveLength(2);
    });
  });

  describe('getMessage', () => {
    it('opens mailbox, fetches one message by UID with body structure + source, then logs out', async () => {
      const message = makeFetchMessage(7);
      const { ctor, connect, logout, mailboxOpen, fetchOne } = buildMockCtor({
        fetchOne: () => Promise.resolve(message)
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 7);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(fetchOne).toHaveBeenCalledWith(
        '7',
        expect.objectContaining({ uid: true, bodyStructure: true, source: true }),
        { uid: true }
      );
      expect(logout).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ...message, body: '', attachments: [] });
    });

    it('returns false when UID does not exist', async () => {
      const { ctor } = buildMockCtor({
        fetchOne: () => Promise.resolve(false)
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 99);
      expect(result).toBe(false);
    });

    it('has no body/attachments when the message has no bodyStructure', async () => {
      const { ctor, download } = buildMockCtor({
        fetchOne: () => Promise.resolve(makeFetchMessage(1))
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 1);

      expect(download).not.toHaveBeenCalled();
      expect(result).toMatchObject({ body: '', attachments: [] });
    });

    it('downloads part "1" as the body for a non-multipart text/plain message', async () => {
      const bodyStructure: MessageStructureObject = { type: 'text/plain', size: 40 };
      const { ctor, download } = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({ ...makeFetchMessage(1), bodyStructure }),
        download: () => Promise.resolve(makeDownload('Hello there'))
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 1);

      expect(download).toHaveBeenCalledWith('1', '1', { uid: true });
      expect(result).toMatchObject({ body: 'Hello there', attachments: [] });
    });

    it('prefers text/plain over text/html in a multipart/alternative message', async () => {
      const bodyStructure: MessageStructureObject = {
        type: 'multipart/alternative',
        childNodes: [
          { part: '1', type: 'text/plain', size: 20 },
          { part: '2', type: 'text/html', size: 60 }
        ]
      };
      const { ctor, download } = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({ ...makeFetchMessage(1), bodyStructure }),
        download: () => Promise.resolve(makeDownload('Plain text body'))
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 1);

      expect(download).toHaveBeenCalledWith('1', '1', { uid: true });
      expect(result).toMatchObject({ body: 'Plain text body', attachments: [] });
    });

    it('falls back to text/html as-is when there is no text/plain part', async () => {
      const bodyStructure: MessageStructureObject = {
        type: 'multipart/mixed',
        childNodes: [{ part: '1', type: 'text/html', size: 60 }]
      };
      const { ctor } = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({ ...makeFetchMessage(1), bodyStructure }),
        download: () => Promise.resolve(makeDownload('<p>Hi</p>'))
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 1);

      expect(result).toMatchObject({ body: '<p>Hi</p>', attachments: [] });
    });

    it('extracts attachment metadata and excludes the chosen text part', async () => {
      const bodyStructure: MessageStructureObject = {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', size: 20 },
          {
            part: '2',
            type: 'application/pdf',
            size: 5000,
            disposition: 'attachment',
            dispositionParameters: { filename: 'invoice.pdf' }
          }
        ]
      };
      const { ctor, download } = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({ ...makeFetchMessage(1), bodyStructure }),
        download: () => Promise.resolve(makeDownload('See attached invoice'))
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 1);

      expect(download).toHaveBeenCalledWith('1', '1', { uid: true });
      expect(result).toMatchObject({
        body: 'See attached invoice',
        attachments: [
          { partId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 5000 }
        ]
      });
    });

    it('leaves body empty and does not call download when there is no text part', async () => {
      const bodyStructure: MessageStructureObject = {
        type: 'application/pdf',
        size: 5000,
        disposition: 'attachment',
        dispositionParameters: { filename: 'invoice.pdf' }
      };
      const { ctor, download } = buildMockCtor({
        fetchOne: () =>
          Promise.resolve({ ...makeFetchMessage(1), bodyStructure })
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getMessage('acc-1', 'INBOX', 1);

      expect(download).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        body: '',
        attachments: [{ partId: '1', filename: 'invoice.pdf', mimeType: 'application/pdf' }]
      });
    });
  });

  describe('getAttachment', () => {
    const bodyStructure: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 20 },
        {
          part: '2',
          type: 'application/pdf',
          size: 5000,
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf' }
        }
      ]
    };

    it('downloads the requested part and returns its decoded content + metadata', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4 fake bytes');
      const { ctor, mailboxOpen, fetchOne, download } = buildMockCtor({
        fetchOne: () => Promise.resolve({ ...makeFetchMessage(1), bodyStructure }),
        download: () =>
          Promise.resolve({
            meta: { contentType: 'application/pdf', filename: 'invoice.pdf' },
            content: Readable.from([pdfBytes])
          })
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getAttachment('acc-1', 'INBOX', 1, '2');

      expect(mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(fetchOne).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ bodyStructure: true }),
        { uid: true }
      );
      expect(download).toHaveBeenCalledWith('1', '2', { uid: true });
      expect(result).toEqual({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.length,
        content: pdfBytes
      });
    });

    it('falls back to bodyStructure metadata when download() does not supply it', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4 fake bytes');
      const { ctor } = buildMockCtor({
        fetchOne: () => Promise.resolve({ ...makeFetchMessage(1), bodyStructure }),
        download: () =>
          Promise.resolve({ meta: { contentType: '' }, content: Readable.from([pdfBytes]) })
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getAttachment('acc-1', 'INBOX', 1, '2');

      expect(result).toMatchObject({ filename: 'invoice.pdf', mimeType: 'application/pdf' });
    });

    it('returns false when the message does not exist', async () => {
      const { ctor, download } = buildMockCtor({
        fetchOne: () => Promise.resolve(false)
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getAttachment('acc-1', 'INBOX', 999, '2');

      expect(result).toBe(false);
      expect(download).not.toHaveBeenCalled();
    });

    it('returns false when the part id does not exist on the message', async () => {
      const { ctor, download } = buildMockCtor({
        fetchOne: () => Promise.resolve({ ...makeFetchMessage(1), bodyStructure })
      });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getAttachment('acc-1', 'INBOX', 1, '99');

      expect(result).toBe(false);
      expect(download).not.toHaveBeenCalled();
    });
  });

  describe('getRawSource', () => {
    it('fetches the message with source: true and returns the raw buffer', async () => {
      const source = Buffer.from('From: a@example.com\r\nSubject: hi\r\n\r\nbody');
      const { ctor, mailboxOpen, fetchOne } = buildMockCtor({
        fetchOne: () => Promise.resolve({ ...makeFetchMessage(1), source })
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getRawSource('acc-1', 'INBOX', 1);

      expect(mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(fetchOne).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ source: true }),
        { uid: true }
      );
      expect(result).toBe(source);
    });

    it('returns false when the message does not exist', async () => {
      const { ctor } = buildMockCtor({ fetchOne: () => Promise.resolve(false) });
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.getRawSource('acc-1', 'INBOX', 999);
      expect(result).toBe(false);
    });
  });

  describe('moveMessage', () => {
    it('opens mailbox, moves message by UID, then logs out', async () => {
      const copyResponse = { uidValidity: BigInt(1), uid: 10, destination: 'Archive' };
      const { ctor, connect, logout, mailboxOpen, messageMove } = buildMockCtor({
        messageMove: () => Promise.resolve(copyResponse)
      });

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      const result = await service.moveMessage('acc-1', 'INBOX', 5, 'Archive');

      expect(connect).toHaveBeenCalledTimes(1);
      expect(mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(messageMove).toHaveBeenCalledWith('5', 'Archive', { uid: true });
      expect(logout).toHaveBeenCalledTimes(1);
      expect(result).toEqual(copyResponse);
    });
  });

  describe('setFlags', () => {
    it('opens mailbox, adds flags, removes flags, then logs out', async () => {
      const { ctor, connect, logout, mailboxOpen, messageFlagsAdd, messageFlagsRemove } = buildMockCtor();

      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await service.setFlags('acc-1', 'INBOX', 3, ['\\Flagged'], ['\\Seen']);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(messageFlagsAdd).toHaveBeenCalledWith('3', ['\\Flagged'], { uid: true });
      expect(messageFlagsRemove).toHaveBeenCalledWith('3', ['\\Seen'], { uid: true });
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it('skips messageFlagsAdd when add list is empty', async () => {
      const { ctor, messageFlagsAdd, messageFlagsRemove } = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await service.setFlags('acc-1', 'INBOX', 3, [], ['\\Seen']);
      expect(messageFlagsAdd).not.toHaveBeenCalled();
      expect(messageFlagsRemove).toHaveBeenCalledTimes(1);
    });

    it('skips messageFlagsRemove when remove list is empty', async () => {
      const { ctor, messageFlagsAdd, messageFlagsRemove } = buildMockCtor();
      const service = createMailboxService(ACCOUNTS, { MailboxClientCtor: ctor });
      await service.setFlags('acc-1', 'INBOX', 3, ['\\Flagged'], []);
      expect(messageFlagsAdd).toHaveBeenCalledTimes(1);
      expect(messageFlagsRemove).not.toHaveBeenCalled();
    });
  });
});
