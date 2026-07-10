import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../utils/config/schema.js';

export class ImapConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImapConnectionError';
  }
}

export type ImapClient = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
};

export type ImapClientConstructor = new (options: {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}) => ImapClient;

export type CreateConnectedImapClientOptions = {
  ImapClientCtor?: ImapClientConstructor;
};

export const createConnectedImapClient = async (
  account: AccountConfig,
  options: CreateConnectedImapClientOptions = {}
): Promise<{ client: ImapClient; close: () => Promise<void> }> => {
  const ImapClientCtor =
    options.ImapClientCtor ?? (ImapFlow as ImapClientConstructor);
  const client = new ImapClientCtor({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.auth.user,
      pass: account.auth.pass
    }
  });

  try {
    await client.connect();
  } catch (error) {
    throw new ImapConnectionError(
      `Failed to connect to IMAP account "${account.id}"`,
      { cause: error as Error }
    );
  }

  return {
    client,
    close: async () => {
      try {
        await client.logout();
      } catch {
        // Intentionally ignored: safe-close helper should never throw.
      }
    }
  };
};
