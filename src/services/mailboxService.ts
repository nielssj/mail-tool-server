import { ImapFlow } from 'imapflow';
import type {
  ListResponse,
  FetchMessageObject,
  FetchQueryObject,
  MailboxObject,
  CopyResponseObject,
  StoreOptions
} from 'imapflow';
import type { AccountConfig } from '../utils/config/schema.js';
import { ImapConnectionError } from '../imap/clientFactory.js';

export type { ListResponse, FetchMessageObject };

export type MailboxClient = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  list: () => Promise<ListResponse[]>;
  mailboxOpen: (path: string) => Promise<MailboxObject>;
  fetchAll: (
    range: string,
    query: FetchQueryObject,
    options?: { uid?: boolean }
  ) => Promise<FetchMessageObject[]>;
  fetchOne: (
    seq: string,
    query: FetchQueryObject,
    options?: { uid?: boolean }
  ) => Promise<FetchMessageObject | false>;
  messageMove: (
    range: string,
    destination: string,
    options?: { uid?: boolean }
  ) => Promise<CopyResponseObject | false>;
  messageFlagsAdd: (
    range: string,
    flags: string[],
    options?: StoreOptions
  ) => Promise<boolean>;
  messageFlagsRemove: (
    range: string,
    flags: string[],
    options?: StoreOptions
  ) => Promise<boolean>;
};

export type MailboxClientConstructor = new (options: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger?: false;
}) => MailboxClient;

export type ListMessagesOptions = {
  limit?: number;
  sinceUid?: number;
};

export type MailboxServiceOptions = {
  MailboxClientCtor?: MailboxClientConstructor;
};

const FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true
};

const withClient = async <T>(
  account: AccountConfig,
  ctor: MailboxClientConstructor,
  fn: (client: MailboxClient) => Promise<T>
): Promise<T> => {
  const client = new ctor({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.auth.user, pass: account.auth.pass },
    logger: false
  });

  try {
    await client.connect();
  } catch (error) {
    throw new ImapConnectionError(
      `Failed to connect to IMAP account "${account.id}"`,
      { cause: error as Error }
    );
  }

  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // Intentionally ignored: best-effort close.
    }
  }
};

const findAccount = (
  accounts: AccountConfig[],
  accountId: string
): AccountConfig => {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new Error(`Unknown account id: "${accountId}"`);
  }
  return account;
};

export const createMailboxService = (
  accounts: AccountConfig[],
  options: MailboxServiceOptions = {}
) => {
  const ctor =
    options.MailboxClientCtor ?? (ImapFlow as unknown as MailboxClientConstructor);

  const listMailboxes = async (accountId: string): Promise<ListResponse[]> => {
    const account = findAccount(accounts, accountId);
    return withClient(account, ctor, (client) => client.list());
  };

  const listMessages = async (
    accountId: string,
    mailbox: string,
    opts: ListMessagesOptions = {}
  ): Promise<FetchMessageObject[]> => {
    const account = findAccount(accounts, accountId);
    return withClient(account, ctor, async (client) => {
      await client.mailboxOpen(mailbox);
      const range = opts.sinceUid != null ? `${opts.sinceUid}:*` : '1:*';
      const all = await client.fetchAll(range, FETCH_QUERY, { uid: true });
      if (opts.limit != null && all.length > opts.limit) {
        return all.slice(-opts.limit);
      }
      return all;
    });
  };

  const getMessage = async (
    accountId: string,
    mailbox: string,
    uid: number
  ): Promise<FetchMessageObject | false> => {
    const account = findAccount(accounts, accountId);
    return withClient(account, ctor, async (client) => {
      await client.mailboxOpen(mailbox);
      return client.fetchOne(String(uid), FETCH_QUERY, { uid: true });
    });
  };

  const moveMessage = async (
    accountId: string,
    mailbox: string,
    uid: number,
    destination: string
  ): Promise<CopyResponseObject | false> => {
    const account = findAccount(accounts, accountId);
    return withClient(account, ctor, async (client) => {
      await client.mailboxOpen(mailbox);
      return client.messageMove(String(uid), destination, { uid: true });
    });
  };

  const setFlags = async (
    accountId: string,
    mailbox: string,
    uid: number,
    add: string[],
    remove: string[]
  ): Promise<void> => {
    const account = findAccount(accounts, accountId);
    return withClient(account, ctor, async (client) => {
      await client.mailboxOpen(mailbox);
      if (add.length > 0) {
        await client.messageFlagsAdd(String(uid), add, { uid: true });
      }
      if (remove.length > 0) {
        await client.messageFlagsRemove(String(uid), remove, { uid: true });
      }
    });
  };

  return { listMailboxes, listMessages, getMessage, moveMessage, setFlags };
};
