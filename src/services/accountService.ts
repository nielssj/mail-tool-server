import type { AccountConfig } from '../utils/config/schema.js';

export type AccountSummary = {
  id: string;
  host: string;
  watchMailboxes: string[];
};

export type AccountService = {
  listAccounts: () => Promise<AccountSummary[]>;
};

export const createAccountService = (accounts: AccountConfig[]): AccountService => {
  const listAccounts = async (): Promise<AccountSummary[]> =>
    accounts.map((account) => ({
      id: account.id,
      host: account.host,
      watchMailboxes: account.watchMailboxes
    }));

  return { listAccounts };
};
