import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { MailboxService } from '../src/services/mailboxService.js';
import { createAccountService } from '../src/services/accountService.js';
import type { AccountConfig } from '../src/utils/config/schema.js';
import type { ListResponse } from 'imapflow';

const ACCOUNTS: AccountConfig[] = [
  {
    id: 'acc-1',
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'user@example.com', pass: 'super-secret' },
    watchMailboxes: ['INBOX'],
    dispatchers: []
  }
];

const makeMailboxListEntry = (overrides: Partial<ListResponse> = {}): ListResponse => ({
  path: 'INBOX',
  pathAsListed: 'INBOX',
  name: 'INBOX',
  delimiter: '/',
  parent: [],
  parentPath: '',
  flags: new Set(['\\Unmarked']),
  listed: true,
  subscribed: true,
  ...overrides
});

describe('account discovery tools', () => {
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

  describe('list_accounts', () => {
    it('returns id/host/watchMailboxes and never exposes auth', async () => {
      const mailboxService = { listMailboxes: vi.fn() } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({ name: 'list_accounts', arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        accounts: [{ id: 'acc-1', host: 'imap.example.com', watchMailboxes: ['INBOX'] }]
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('super-secret');
      expect(JSON.stringify(result)).not.toContain('super-secret');
    });
  });

  describe('list_mailboxes', () => {
    it('returns a compact mailbox summary for a known account', async () => {
      const listMailboxes = vi.fn(async () => [
        makeMailboxListEntry(),
        makeMailboxListEntry({ path: 'Sent', name: 'Sent', specialUse: '\\Sent' })
      ]);
      const mailboxService = { listMailboxes } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'list_mailboxes',
        arguments: { accountId: 'acc-1' }
      });

      expect(listMailboxes).toHaveBeenCalledWith('acc-1');
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        mailboxes: [
          { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: ['\\Unmarked'] },
          { path: 'Sent', name: 'Sent', delimiter: '/', flags: ['\\Unmarked'], specialUse: '\\Sent' }
        ]
      });
    });

    it('returns a tool error (not a thrown exception) for an unknown accountId', async () => {
      const listMailboxes = vi.fn(async () => {
        throw new Error('Unknown account id: "does-not-exist"');
      });
      const mailboxService = { listMailboxes } as unknown as MailboxService;
      const c = await connect(mailboxService);

      const result = await c.callTool({
        name: 'list_mailboxes',
        arguments: { accountId: 'does-not-exist' }
      });

      expect(result.isError).toBe(true);
    });
  });
});
