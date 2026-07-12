import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { ReadOnlyAccountError, type MailboxService } from '../src/services/mailboxService.js';
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

describe('mutation tools', () => {
  let client: Client | undefined;

  const connect = async (mailboxService: Partial<MailboxService>): Promise<Client> => {
    const server = createMcpServer({
      mailboxService: mailboxService as MailboxService,
      accounts: ACCOUNTS
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

  it('advertises destructiveHint on move_message and idempotentHint on set_flags', async () => {
    const c = await connect({});
    const { tools } = await c.listTools();

    const moveMessage = tools.find((t) => t.name === 'move_message');
    const setFlags = tools.find((t) => t.name === 'set_flags');

    expect(moveMessage?.annotations).toMatchObject({ destructiveHint: true });
    expect(setFlags?.annotations).toMatchObject({ idempotentHint: true });
  });

  describe('move_message', () => {
    it('moves the message and returns { ok: true, destination }', async () => {
      const moveMessage = vi.fn(async () => ({
        path: 'INBOX',
        destination: 'Archive',
        uidValidity: BigInt(1)
      }));
      const c = await connect({ moveMessage });

      const result = await c.callTool({
        name: 'move_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5, destination: 'Archive' }
      });

      expect(moveMessage).toHaveBeenCalledWith('acc-1', 'INBOX', 5, 'Archive');
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ ok: true, destination: 'Archive' });
    });

    it('returns a tool error for a missing uid', async () => {
      const moveMessage = vi.fn(async () => false as const);
      const c = await connect({ moveMessage });

      const result = await c.callTool({
        name: 'move_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 999, destination: 'Archive' }
      });

      expect(result.isError).toBe(true);
    });

    it('returns a tool error for a read-only account', async () => {
      const moveMessage = vi.fn(async () => {
        throw new ReadOnlyAccountError('acc-1', 'move_message');
      });
      const c = await connect({ moveMessage });

      const result = await c.callTool({
        name: 'move_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5, destination: 'Archive' }
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'Account "acc-1" is read-only; move_message is disabled.' }
      ]);
    });
  });

  describe('set_flags', () => {
    it('adds and removes flags and returns { ok: true }', async () => {
      const setFlags = vi.fn(async () => undefined);
      const c = await connect({ setFlags });

      const result = await c.callTool({
        name: 'set_flags',
        arguments: {
          accountId: 'acc-1',
          mailbox: 'INBOX',
          uid: 3,
          add: ['\\Flagged'],
          remove: ['\\Seen']
        }
      });

      expect(setFlags).toHaveBeenCalledWith('acc-1', 'INBOX', 3, ['\\Flagged'], ['\\Seen']);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ ok: true });
    });

    it('defaults add/remove to empty arrays when omitted', async () => {
      const setFlags = vi.fn(async () => undefined);
      const c = await connect({ setFlags });

      await c.callTool({
        name: 'set_flags',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 3 }
      });

      expect(setFlags).toHaveBeenCalledWith('acc-1', 'INBOX', 3, [], []);
    });

    it('rejects an empty-string flag via input validation', async () => {
      const setFlags = vi.fn(async () => undefined);
      const c = await connect({ setFlags });

      const result = await c.callTool({
        name: 'set_flags',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 3, add: [''] }
      });

      expect(result.isError).toBe(true);
      expect(setFlags).not.toHaveBeenCalled();
    });

    it('returns a tool error for a read-only account', async () => {
      const setFlags = vi.fn(async () => {
        throw new ReadOnlyAccountError('acc-1', 'set_flags');
      });
      const c = await connect({ setFlags });

      const result = await c.callTool({
        name: 'set_flags',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 3, add: ['\\Flagged'] }
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'Account "acc-1" is read-only; set_flags is disabled.' }
      ]);
    });
  });
});
