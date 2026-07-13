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
import * as telemetry from '../telemetry/instruments.js';
import { recordMailboxOperation } from '../telemetry/mailboxOperationMetrics.js';

export type { ListResponse, FetchMessageObject };

export class ReadOnlyAccountError extends Error {
  constructor(accountId: string, operation: string) {
    super(`Account "${accountId}" is read-only; ${operation} is disabled.`);
    this.name = 'ReadOnlyAccountError';
  }
}

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

export type AttachmentContent = {
  filename?: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
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
  getAttachment: (
    accountId: string,
    mailbox: string,
    uid: number,
    partId: string
  ) => Promise<AttachmentContent | false>;
  getRawSource: (
    accountId: string,
    mailbox: string,
    uid: number
  ) => Promise<Buffer | false>;
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

/** Hard ceiling for getAttachment/getRawSource — both fully buffer their
 * content in memory (see PR #19 discussion: streaming isn't worth the
 * complexity, since S3's 5MB multipart minimum means typical mail
 * attachments get buffered whole either way). This bounds worst-case memory
 * from a single outlier request; checked against the pre-decode size IMAP
 * already reports (bodyStructure part size / RFC822.SIZE) before fetching
 * any content, so an oversized attachment or message is rejected without
 * ever pulling its bytes into memory. */
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

const tooLargeError = (kind: string, id: string | number, sizeBytes: number): Error =>
  new Error(
    `${kind} "${id}" is ${sizeBytes} bytes, exceeding the ${MAX_FETCH_BYTES}-byte limit`
  );

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

  const connectStart = performance.now();
  try {
    await client.connect();
  } catch (error) {
    telemetry.imapConnectionDuration.record((performance.now() - connectStart) / 1000, {
      'account.id': account.id,
      outcome: 'error'
    });
    telemetry.imapConnectionErrors.add(1, { 'account.id': account.id });
    throw new ImapConnectionError(
      `Failed to connect to IMAP account "${account.id}"`,
      { cause: error as Error }
    );
  }
  telemetry.imapConnectionDuration.record((performance.now() - connectStart) / 1000, {
    'account.id': account.id,
    outcome: 'ok'
  });

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

const findNodeByPart = (
  node: MessageStructureObject,
  partId: string
): MessageStructureObject | undefined => {
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) {
      const found = findNodeByPart(child, partId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  return (node.part ?? '1') === partId ? node : undefined;
};

const streamToBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const streamToString = async (stream: NodeJS.ReadableStream): Promise<string> =>
  (await streamToBuffer(stream)).toString('utf8');

export const createMailboxService = (
  accounts: AccountConfig[],
  options: MailboxServiceOptions = {}
): MailboxService => {
  const ctor =
    options.MailboxClientCtor ?? (ImapFlow as unknown as MailboxClientConstructor);

  const resolveAccount = (accountId: string): AccountConfig => findAccount(accounts, accountId);

  const listMailboxes = (accountId: string): Promise<ListResponse[]> =>
    recordMailboxOperation('list_mailboxes', accountId, resolveAccount, (account) =>
      withClient(account, ctor, (client) => client.list())
    );

  const listMessages = (
    accountId: string,
    mailbox: string,
    opts: ListMessagesOptions = {}
  ): Promise<FetchMessageObject[]> =>
    recordMailboxOperation('list_messages', accountId, resolveAccount, (account) =>
      withClient(account, ctor, async (client) => {
        await client.mailboxOpen(mailbox);
        const range = opts.sinceUid != null ? `${opts.sinceUid}:*` : '1:*';
        const all = await client.fetchAll(range, LIST_FETCH_QUERY, { uid: true });
        if (opts.limit != null && all.length > opts.limit) {
          return all.slice(-opts.limit);
        }
        return all;
      })
    );

  const getMessage = (
    accountId: string,
    mailbox: string,
    uid: number
  ): Promise<MessageDetail | false> =>
    recordMailboxOperation('get_message', accountId, resolveAccount, (account) =>
      withClient(account, ctor, async (client) => {
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
      })
    );

  const getAttachment = (
    accountId: string,
    mailbox: string,
    uid: number,
    partId: string
  ): Promise<AttachmentContent | false> =>
    recordMailboxOperation('get_attachment', accountId, resolveAccount, (account) =>
      withClient(account, ctor, async (client) => {
        await client.mailboxOpen(mailbox);
        const message = await client.fetchOne(
          String(uid),
          { uid: true, bodyStructure: true },
          { uid: true }
        );
        if (!message || !message.bodyStructure) {
          return false;
        }

        const node = findNodeByPart(message.bodyStructure, partId);
        if (!node) {
          return false;
        }

        if (node.size != null && node.size > MAX_FETCH_BYTES) {
          throw tooLargeError('Attachment part', partId, node.size);
        }

        const downloaded = await client.download(String(uid), partId, { uid: true });
        const content = await streamToBuffer(downloaded.content);

        return {
          filename:
            downloaded.meta.filename ?? node.dispositionParameters?.filename ?? node.parameters?.name,
          mimeType: downloaded.meta.contentType || node.type,
          sizeBytes: content.length,
          content
        };
      })
    );

  const getRawSource = (
    accountId: string,
    mailbox: string,
    uid: number
  ): Promise<Buffer | false> =>
    recordMailboxOperation('get_raw_source', accountId, resolveAccount, (account) =>
      withClient(account, ctor, async (client) => {
        await client.mailboxOpen(mailbox);

        const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
        if (!meta) {
          return false;
        }
        if (meta.size != null && meta.size > MAX_FETCH_BYTES) {
          throw tooLargeError('Message', uid, meta.size);
        }

        const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!message || !message.source) {
          return false;
        }
        return message.source;
      })
    );

  const moveMessage = (
    accountId: string,
    mailbox: string,
    uid: number,
    destination: string
  ): Promise<CopyResponseObject | false> =>
    recordMailboxOperation('move_message', accountId, resolveAccount, (account) => {
      if (account.readOnly) {
        throw new ReadOnlyAccountError(accountId, 'move_message');
      }
      return withClient(account, ctor, async (client) => {
        await client.mailboxOpen(mailbox);
        return client.messageMove(String(uid), destination, { uid: true });
      });
    });

  const setFlags = (
    accountId: string,
    mailbox: string,
    uid: number,
    add: string[],
    remove: string[]
  ): Promise<void> =>
    recordMailboxOperation('set_flags', accountId, resolveAccount, (account) => {
      if (account.readOnly) {
        throw new ReadOnlyAccountError(accountId, 'set_flags');
      }
      return withClient(account, ctor, async (client) => {
        await client.mailboxOpen(mailbox);
        if (add.length > 0) {
          await client.messageFlagsAdd(String(uid), add, { uid: true });
        }
        if (remove.length > 0) {
          await client.messageFlagsRemove(String(uid), remove, { uid: true });
        }
      });
    });

  return {
    listMailboxes,
    listMessages,
    getMessage,
    getAttachment,
    getRawSource,
    moveMessage,
    setFlags
  };
};
