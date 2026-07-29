import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/mcp/httpServer.js';
import type { MailboxService } from '../src/services/mailboxService.js';
import { createAccountService } from '../src/services/accountService.js';
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
  setFlags: async () => undefined,
  createDraft: async () => ({ mailbox: 'Drafts' })
});

describe('createMcpHttpServer', () => {
  let server: ReturnType<typeof createMcpHttpServer>;
  let baseUrl: URL;
  let client: Client | undefined;

  beforeEach(async () => {
    server = createMcpHttpServer({
      mailboxService: makeMailboxService(),
      accountService: createAccountService(ACCOUNTS)
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('responds to initialize and lists the registered tools over Streamable HTTP', async () => {
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(baseUrl));

    const serverVersion = client.getServerVersion();
    expect(serverVersion?.name).toBe('mail-tool-server');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_draft',
      'export_message',
      'get_attachment',
      'get_message',
      'list_accounts',
      'list_mailboxes',
      'list_messages',
      'move_message',
      'set_flags'
    ]);
  });

  it('returns 404 for unknown paths', async () => {
    const response = await fetch(new URL('/not-mcp', baseUrl));
    expect(response.status).toBe(404);
  });

  it('returns 405 for GET /mcp (no session support in stateless mode)', async () => {
    const response = await fetch(baseUrl, { method: 'GET' });
    expect(response.status).toBe(405);
  });
});
