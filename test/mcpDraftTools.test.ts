import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
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

describe('draft tools', () => {
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

  describe('create_draft', () => {
    it('saves the draft and returns { mailbox, uid, uidValidity }', async () => {
      const createDraft = vi.fn(async () => ({ mailbox: 'Drafts', uid: 9, uidValidity: '123' }));
      const c = await connect({ createDraft });

      const result = await c.callTool({
        name: 'create_draft',
        arguments: {
          accountId: 'acc-1',
          mailbox: 'Drafts',
          to: ['jane@example.com'],
          subject: 'Hello',
          text: 'Hi there',
          attachments: [
            { filename: 'a.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') }
          ]
        }
      });

      expect(createDraft).toHaveBeenCalledWith('acc-1', 'Drafts', {
        to: ['jane@example.com'],
        cc: undefined,
        bcc: undefined,
        subject: 'Hello',
        text: 'Hi there',
        html: undefined,
        attachments: [
          { filename: 'a.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') }
        ]
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ mailbox: 'Drafts', uid: 9, uidValidity: '123' });
    });

    it('works with no fields beyond accountId/mailbox', async () => {
      const createDraft = vi.fn(async () => ({ mailbox: 'Drafts' }));
      const c = await connect({ createDraft });

      const result = await c.callTool({
        name: 'create_draft',
        arguments: { accountId: 'acc-1', mailbox: 'Drafts' }
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ mailbox: 'Drafts' });
    });

    it('rejects an empty-string recipient via input validation', async () => {
      const createDraft = vi.fn(async () => ({ mailbox: 'Drafts' }));
      const c = await connect({ createDraft });

      const result = await c.callTool({
        name: 'create_draft',
        arguments: { accountId: 'acc-1', mailbox: 'Drafts', to: [''] }
      });

      expect(result.isError).toBe(true);
      expect(createDraft).not.toHaveBeenCalled();
    });

    it('returns a tool error for a read-only account', async () => {
      const createDraft = vi.fn(async () => {
        throw new ReadOnlyAccountError('acc-1', 'create_draft');
      });
      const c = await connect({ createDraft });

      const result = await c.callTool({
        name: 'create_draft',
        arguments: { accountId: 'acc-1', mailbox: 'Drafts' }
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'Account "acc-1" is read-only; create_draft is disabled.' }
      ]);
    });
  });
});
