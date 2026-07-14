import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { MailboxService } from '../src/services/mailboxService.js';
import { createAccountService } from '../src/services/accountService.js';
import type { BlobStore, StagedBlob } from '../src/storage/blobStore.js';
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

const STAGED: StagedBlob = {
  url: 'https://blobs.example.com/staged-key?sig=abc',
  expiresAt: '2024-01-01T00:15:00.000Z'
};

describe('delivery tools', () => {
  let client: Client | undefined;

  const connect = async (
    mailboxService: Partial<MailboxService>,
    blobStore?: BlobStore
  ): Promise<Client> => {
    const server = createMcpServer({
      mailboxService: mailboxService as MailboxService,
      accountService: createAccountService(ACCOUNTS),
      blobStore
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

  describe('get_attachment', () => {
    it('stages the attachment bytes and returns the pre-signed URL + metadata', async () => {
      const content = Buffer.from('%PDF-1.4 fake bytes');
      const getAttachment = vi.fn(async () => ({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        content
      }));
      const stage = vi.fn(async () => STAGED);
      const c = await connect({ getAttachment }, { stage });

      const result = await c.callTool({
        name: 'get_attachment',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5, partId: '2' }
      });

      expect(getAttachment).toHaveBeenCalledWith('acc-1', 'INBOX', 5, '2');
      expect(stage).toHaveBeenCalledWith({
        body: content,
        contentType: 'application/pdf',
        filename: 'invoice.pdf',
        kind: 'attachment'
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        url: STAGED.url,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        expiresAt: STAGED.expiresAt
      });
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/PDF-1\.4/);
    });

    it('sanitizes an attacker-controlled filename before staging', async () => {
      const content = Buffer.from('bytes');
      const getAttachment = vi.fn(async () => ({
        filename: '../../etc/passwd',
        mimeType: 'application/octet-stream',
        sizeBytes: content.length,
        content
      }));
      const stage = vi.fn<BlobStore['stage']>(async () => STAGED);
      const c = await connect({ getAttachment }, { stage });

      const result = await c.callTool({
        name: 'get_attachment',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5, partId: '2' }
      });

      const stagedFilename = stage.mock.calls[0]![0].filename;
      expect(stagedFilename).not.toContain('/');
      expect((result.structuredContent as { filename: string }).filename).toBe(stagedFilename);
    });

    it('returns a tool error for an unknown uid/part id', async () => {
      const getAttachment = vi.fn(async () => false as const);
      const stage = vi.fn(async () => STAGED);
      const c = await connect({ getAttachment }, { stage });

      const result = await c.callTool({
        name: 'get_attachment',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 999, partId: '9' }
      });

      expect(result.isError).toBe(true);
      expect(stage).not.toHaveBeenCalled();
    });

    it('returns a tool error when object storage is not configured', async () => {
      const getAttachment = vi.fn();
      const c = await connect({ getAttachment }, undefined);

      const result = await c.callTool({
        name: 'get_attachment',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5, partId: '2' }
      });

      expect(result.isError).toBe(true);
      expect(getAttachment).not.toHaveBeenCalled();
    });

    it('surfaces the service-level oversized-attachment rejection as a tool error', async () => {
      const getAttachment = vi.fn(async () => {
        throw new Error('Attachment part "2" is 26214401 bytes, exceeding the 26214400-byte limit');
      });
      const stage = vi.fn(async () => STAGED);
      const c = await connect({ getAttachment }, { stage });

      const result = await c.callTool({
        name: 'get_attachment',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 5, partId: '2' }
      });

      expect(result.isError).toBe(true);
      expect(stage).not.toHaveBeenCalled();
    });
  });

  describe('export_message', () => {
    it('stages the full raw source and returns the pre-signed URL + metadata', async () => {
      const source = Buffer.from('From: a@example.com\r\nSubject: hi\r\n\r\nbody');
      const getRawSource = vi.fn(async () => source);
      const stage = vi.fn(async () => STAGED);
      const c = await connect({ getRawSource }, { stage });

      const result = await c.callTool({
        name: 'export_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 7 }
      });

      expect(getRawSource).toHaveBeenCalledWith('acc-1', 'INBOX', 7);
      expect(stage).toHaveBeenCalledWith({
        body: source,
        contentType: 'message/rfc822',
        filename: 'message-7.eml',
        kind: 'message'
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        url: STAGED.url,
        filename: 'message-7.eml',
        mimeType: 'message/rfc822',
        sizeBytes: source.length,
        expiresAt: STAGED.expiresAt
      });
    });

    it('returns a tool error for a missing uid', async () => {
      const getRawSource = vi.fn(async () => false as const);
      const stage = vi.fn(async () => STAGED);
      const c = await connect({ getRawSource }, { stage });

      const result = await c.callTool({
        name: 'export_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 999 }
      });

      expect(result.isError).toBe(true);
      expect(stage).not.toHaveBeenCalled();
    });

    it('surfaces the service-level oversized-message rejection as a tool error', async () => {
      const getRawSource = vi.fn(async () => {
        throw new Error('Message "7" is 26214401 bytes, exceeding the 26214400-byte limit');
      });
      const stage = vi.fn(async () => STAGED);
      const c = await connect({ getRawSource }, { stage });

      const result = await c.callTool({
        name: 'export_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 7 }
      });

      expect(result.isError).toBe(true);
      expect(stage).not.toHaveBeenCalled();
    });

    it('returns a tool error when object storage is not configured', async () => {
      const getRawSource = vi.fn();
      const c = await connect({ getRawSource }, undefined);

      const result = await c.callTool({
        name: 'export_message',
        arguments: { accountId: 'acc-1', mailbox: 'INBOX', uid: 7 }
      });

      expect(result.isError).toBe(true);
      expect(getRawSource).not.toHaveBeenCalled();
    });
  });
});
