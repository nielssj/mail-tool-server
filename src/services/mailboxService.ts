import { ImapFlow } from 'imapflow';
import type {
  ListResponse,
  FetchMessageObject,
  FetchQueryObject,
  MailboxObject,
  MessageStructureObject,
  CopyResponseObject,
  StoreOptions
} from 'imapflow';
import type { AccountConfig } from '../utils/config/schema.js';
import { ImapConnectionError } from '../imap/clientFactory.js';

export type { ListResponse, FetchMessageObject };

export type MessageAttachment = {
  partId: string;
  filename?: string;
  mimeType: string;
  sizeBytes?: number;
};

export type MessageDetail = FetchMessageObject & {
  /** Decoded text of the preferred body part — text/plain if present,
   * otherwise the first text/* part as-is (no HTML-to-text rendering). */
  body: string;
  /** Attachment metadata only — never bytes. */
  attachments: MessageAttachment[];
};

export type DownloadedPart = {
  meta: {
    contentType: string;
    charset?: string;
    disposition?: string;
    filename?: string;
    encoding?: string;
  };
  content: NodeJS.ReadableStream;
};

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
  download: (
    range: string,
    part: string | undefined,
    options?: { uid?: boolean }
  ) => Promise<DownloadedPart>;
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

export type MailboxService = {
  listMailboxes: (accountId: string) => Promise<ListResponse[]>;
  listMessages: (
    accountId: string,
    mailbox: string,
    opts?: ListMessagesOptions
  ) => Promise<FetchMessageObject[]>;
  getMessage: (
    accountId: string,
    mailbox: string,
    uid: number
  ) => Promise<MessageDetail | false>;
  moveMessage: (
    accountId: string,
    mailbox: string,
    uid: number,
    destination: string
  ) => Promise<CopyResponseObject | false>;
  setFlags: (
    accountId: string,
    mailbox: string,
    uid: number,
    add: string[],
    remove: string[]
  ) => Promise<void>;
};

/** Raw byte cap for the list-view snippet fetch — kept generous relative to
 * the short text a summary actually shows, to leave room for multi-byte
 * UTF-8 / quoted-printable expansion before format.ts trims it down. */
const SNIPPET_FETCH_MAX_BYTES = 1024;

const LIST_FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  // Best-effort snippet source: part "1" is the first MIME part in document
  // order, which for plain-text and multipart/alternative messages is
  // conventionally the text body. Raw bytes, undecoded — good enough for a
  // triage preview; get_message does proper part selection and decoding.
  bodyParts: [{ key: '1', maxLength: SNIPPET_FETCH_MAX_BYTES }]
};

const DETAIL_FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  source: true
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

const isTextType = (type: string): boolean => type.toLowerCase().startsWith('text/');

/** Depth-first leaves only — a MIME node is either a container (childNodes)
 * or content, never both. */
const collectTextLeaves = (
  node: MessageStructureObject,
  acc: MessageStructureObject[] = []
): MessageStructureObject[] => {
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) {
      collectTextLeaves(child, acc);
    }
    return acc;
  }
  if (node.disposition !== 'attachment' && node.type && isTextType(node.type)) {
    acc.push(node);
  }
  return acc;
};

const findPreferredTextPart = (
  root: MessageStructureObject
): MessageStructureObject | undefined => {
  const leaves = collectTextLeaves(root);
  return leaves.find((leaf) => leaf.type.toLowerCase() === 'text/plain') ?? leaves[0];
};

const collectAttachments = (
  node: MessageStructureObject,
  textPart: MessageStructureObject | undefined,
  acc: MessageAttachment[] = []
): MessageAttachment[] => {
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) {
      collectAttachments(child, textPart, acc);
    }
    return acc;
  }

  if (node === textPart) {
    return acc;
  }

  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (node.disposition === 'attachment' || filename) {
    acc.push({
      partId: node.part ?? '1',
      filename,
      mimeType: node.type,
      sizeBytes: node.size
    });
  }
  return acc;
};

const streamToString = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const createMailboxService = (
  accounts: AccountConfig[],
  options: MailboxServiceOptions = {}
): MailboxService => {
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
      const all = await client.fetchAll(range, LIST_FETCH_QUERY, { uid: true });
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
  ): Promise<MessageDetail | false> => {
    const account = findAccount(accounts, accountId);
    return withClient(account, ctor, async (client) => {
      await client.mailboxOpen(mailbox);
      const message = await client.fetchOne(String(uid), DETAIL_FETCH_QUERY, {
        uid: true
      });
      if (!message) {
        return false;
      }

      let body = '';
      let attachments: MessageAttachment[] = [];

      if (message.bodyStructure) {
        const textPart = findPreferredTextPart(message.bodyStructure);
        if (textPart) {
          const downloaded = await client.download(String(uid), textPart.part ?? '1', {
            uid: true
          });
          body = await streamToString(downloaded.content);
        }
        attachments = collectAttachments(message.bodyStructure, textPart);
      }

      return { ...message, body, attachments };
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
