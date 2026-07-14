import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { DEFAULT_BODY_CAP_CHARS } from '../src/mcp/format.js';
import type { MailboxService, MessageDetail } from '../src/services/mailboxService.js';
import { createAccountService } from '../src/services/accountService.js';
import type { AccountConfig } from '../src/utils/config/schema.js';
import type { FetchMessageObject } from 'imapflow';

const ACCOUNTS: AccountConfig[] = [
  {
    id: 'acc-1',
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'user@example.com', pass: 'secret' },
    watchMailboxes: ['INBOX'],
    dispatchers: []
  }
];

const makeFetchMessage = (uid: number): FetchMessageObject & { bodyParts?: Map<string, Buffer> } => ({
  seq: uid,
  uid,
  flags: new Set(['\\Seen']),
  envelope: {
    subject: `Subject ${uid}`,
    from: [{ address: 'sender@example.com', name: 'Sender' }],
    date: new Date('2024-01-01T00:00:00.000Z')
  },
  internalDate: new Date('2024-01-01'),
  size: 1024,
  bodyParts: new Map([['1', Buffer.from('  Hello   world  \n\n', 'utf8')]])
});

const makeMessageDetail = (uid: number, overrides: Partial<MessageDetail> = {}): MessageDetail => ({
  ...makeFetchMessage(uid),
  body: 'Hello world',
  attachments: [],
  ...overrides
});

describe('message tools', () => {
  let client: Client | undefined;

  const connect = async (mailboxService: MailboxService): Promise<Client> => {
    const server = createMcpServer({ mailboxService, accountService: createAccountService(ACCOUNTS) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  describe('list_messages', () => {
    it('returns compact summaries (no full body) with a default limit', async () => {
      const listMessages = vi.fn(async () => [makeFetchMessage(1), makeFetchMessage(2)]);
      const mailboxService = { listMessages } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'list_messages',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX' }
      });

      expect(listMessages).toHaveBeenCalledWith('acc-1', 'INBOX', { limit: 50, sinceUid: undefined });
      expect(result.isError).toBeFalsy();
      const messages = (result.structuredContent as { messages: unknown[] }).messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        uid: 1,
        subject: 'Subject 1',
        from: 'Sender <sender@example.com>',
        date: '2024-01-01T00:00:00.000Z',
        flags: ['\\Seen'],
        snippet: 'Hello world'
      });
      expect(JSON.stringify(messages)).not.toMatch(/"body"/);
    });

    it('passes sinceUid through for incremental paging', async () => {
      const listMessages = vi.fn(async () => []);
      const mailboxService = { listMessages } as unknown as MailboxService;
      const c = await connect(mailboxService);

      await c.callTool({
        name: 'list_messages',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', sinceUid: 42, limit: 10 }
      });

      expect(listMessages).toHaveBeenCalledWith('acc-1', 'INBOX', { limit: 10, sinceUid: 42 });
    });

    it('rejects a limit above the hard maximum via input validation', async () => {
      const listMessages = vi.fn();
      const mailboxService = { listMessages } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'list_messages',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', limit: 10_000 }
      });

      expect(result.isError).toBe(true);
      expect(listMessages).not.toHaveBeenCalled();
    });
  });

  describe('get_message', () => {
    it('returns the full body untruncated with attachment metadata, no bytes', async () => {
      const detail = makeMessageDetail(5, {
        attachments: [{ partId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 5000 }]
      });
      const getMessage = vi.fn(async () => detail);
      const mailboxService = { getMessage } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'get_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5 }
      });

      expect(getMessage).toHaveBeenCalledWith('acc-1', 'INBOX', 5);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        uid: 5,
        body: 'Hello world',
        truncated: false,
        attachments: [{ partId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 5000 }]
      });
      expect(result.structuredContent).not.toHaveProperty('hint');
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/"bytes"|"content"/);
    });

    it('truncates the body at the cap and includes the export_message hint', async () => {
      const longBody = 'x'.repeat(DEFAULT_BODY_CAP_CHARS + 500);
      const detail = makeMessageDetail(6, { body: longBody });
      const getMessage = vi.fn(async () => detail);
      const mailboxService = { getMessage } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'get_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 6 }
      });

      const structured = result.structuredContent as { body: string; truncated: boolean; hint?: string };
      expect(structured.body).toHaveLength(DEFAULT_BODY_CAP_CHARS);
      expect(structured.truncated).toBe(true);
      expect(structured.hint).toMatch(/export_message/);
    });

    it('returns a tool error (not a thrown exception) for a missing uid', async () => {
      const getMessage = vi.fn(async () => false as const);
      const mailboxService = { getMessage } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'get_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 999 }
      });

      expect(result.isError).toBe(true);
    });
  });
});
