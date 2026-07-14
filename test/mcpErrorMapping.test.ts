import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { ImapConnectionError } from '../src/imap/clientFactory.js';
import { ReadOnlyAccountError, type MailboxService } from '../src/services/mailboxService.js';
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

/**
 * Per Task 6's acceptance criteria: each error class must be verified
 * "through a tool" (not just unit-tested against errors.ts in isolation),
 * so this drives real tool calls end-to-end via the SDK's in-memory
 * transport and asserts the resulting isError CallToolResult's shape.
 */
describe('error mapping, driven through real tool calls', () => {
  let client: Client | undefined;

  const connect = async (mailboxService: Partial<MailboxService>): Promise<Client> => {
    const server = createMcpServer({
      mailboxService: mailboxService as MailboxService,
      accountService: createAccountService(ACCOUNTS)
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('NOT_FOUND: unknown account, via list_mailboxes', async () => {
    const listMailboxes = vi.fn(async () => {
      throw new Error('Unknown account id: "acc-1"');
    });
    const c = await connect({ listMailboxes });

    const result = await c.callTool({
      name: 'list_mailboxes',
      arguments: { accountId: 'acc-1' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'NOT_FOUND', message: 'Unknown account id: "acc-1"' }
    });
  });

  it('NOT_FOUND: missing message, via get_message', async () => {
    const getMessage = vi.fn(async () => false as const);
    const c = await connect({ getMessage });

    const result = await c.callTool({
      name: 'get_message',
      arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 999 }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Message not found: uid 999 in mailbox "INBOX"'
      }
    });
  });

  it('IMAP_CONNECTION_ERROR: via list_mailboxes', async () => {
    const listMailboxes = vi.fn(async () => {
      throw new ImapConnectionError('Failed to connect to IMAP account "acc-1"');
    });
    const c = await connect({ listMailboxes });

    const result = await c.callTool({
      name: 'list_mailboxes',
      arguments: { accountId: 'acc-1' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'IMAP_CONNECTION_ERROR',
        message: 'Failed to connect to IMAP account "acc-1"'
      }
    });
  });

  it('READ_ONLY_ACCOUNT: via set_flags', async () => {
    const setFlags = vi.fn(async () => {
      throw new ReadOnlyAccountError('acc-1', 'set_flags');
    });
    const c = await connect({ setFlags });

    const result = await c.callTool({
      name: 'set_flags',
      arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 1, add: ['\\Flagged'] }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'READ_ONLY_ACCOUNT',
        message: 'Account "acc-1" is read-only; set_flags is disabled.'
      }
    });
  });

  it('OBJECT_STORAGE_NOT_CONFIGURED: via export_message with no blobStore', async () => {
    const server = createMcpServer({
      mailboxService: { getRawSource: vi.fn() } as unknown as MailboxService,
      accountService: createAccountService(ACCOUNTS)
      // blobStore intentionally omitted
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'export_message',
      arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 1 }
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'OBJECT_STORAGE_NOT_CONFIGURED'
    );
  });

  it('INTERNAL_ERROR: an unexpected error is reduced to a generic message with no leak', async () => {
    const listMailboxes = vi.fn(async () => {
      throw new Error('TypeError: Cannot read properties of undefined at /app/src/secret.ts:88');
    });
    const c = await connect({ listMailboxes });

    const result = await c.callTool({
      name: 'list_mailboxes',
      arguments: { accountId: 'acc-1' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
    });
    expect(JSON.stringify(result)).not.toContain('secret.ts');
    expect(JSON.stringify(result)).not.toContain('TypeError');
  });
});
