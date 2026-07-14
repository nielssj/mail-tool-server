import { describe, it, expect } from 'vitest';
import { createAccountService } from '../src/services/accountService.js';
import type { AccountConfig } from '../src/utils/config/schema.js';

const ACCOUNTS: AccountConfig[] = [
  {
    id: 'acc-1',
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'user@example.com', pass: 'super-secret' },
    watchMailboxes: ['INBOX'],
    dispatchers: []
  },
  {
    id: 'acc-2',
    host: 'imap.other.com',
    port: 993,
    secure: true,
    auth: { user: 'other@example.com', pass: 'another-secret' },
    watchMailboxes: ['INBOX', 'Archive'],
    dispatchers: []
  }
];

describe('createAccountService', () => {
  describe('listAccounts', () => {
    it('returns id/host/watchMailboxes for every configured account', async () => {
      const service = createAccountService(ACCOUNTS);

      const result = await service.listAccounts();

      expect(result).toEqual([
        { id: 'acc-1', host: 'imap.example.com', watchMailboxes: ['INBOX'] },
        { id: 'acc-2', host: 'imap.other.com', watchMailboxes: ['INBOX', 'Archive'] }
      ]);
    });

    it('never exposes auth credentials', async () => {
      const service = createAccountService(ACCOUNTS);

      const result = await service.listAccounts();

      expect(JSON.stringify(result)).not.toContain('super-secret');
      expect(JSON.stringify(result)).not.toContain('another-secret');
    });

    it('returns an empty array when no accounts are configured', async () => {
      const service = createAccountService([]);

      const result = await service.listAccounts();

      expect(result).toEqual([]);
    });
  });
});
