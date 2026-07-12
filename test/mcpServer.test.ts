import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { MailboxService } from '../src/services/mailboxService.js';
import type { AccountConfig } from '../src/utils/config/schema.js';

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

const makeMailboxService = (): MailboxService => ({
  listMailboxes: async () => [],
  listMessages: async () => [],
  getMessage: async () => false,
  getAttachment: async () => false,
  getRawSource: async () => false,
  moveMessage: async () => false,
  setFlags: async () => undefined
});

describe('createMcpServer', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('responds to initialize and lists the registered tools over the in-memory transport', async () => {
    const server = createMcpServer({
      mailboxService: makeMailboxService(),
      accounts: ACCOUNTS
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    const serverVersion = client.getServerVersion();
    expect(serverVersion?.name).toBe('mail-tool-server');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'export_message',
      'get_attachment',
      'get_message',
      'list_accounts',
      'list_mailboxes',
      'list_messages'
    ]);
  });
});
