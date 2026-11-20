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
  on: (event: 'error', listener: (err: Error) => void) => ImapClient;
  off: (event: 'error', listener: (err: Error) => void) => ImapClient;
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

/**
 * Attaches a permanent no-op `error` listener to an IMAP client, for the
 * whole life of the client.
 *
 * ImapFlow can emit `error` *after* `connect()` has already rejected: if the
 * socket closes mid-handshake (e.g. the server answers "Too many simultaneous
 * connections for your account" with a BYE), `close()` rejects the connect
 * promise with "Unexpected close", but the detached `startSession()` chain
 * keeps going, fails on its next step ("Already logged out" /
 * "Connection not available"), and -- with the connect promise already
 * settled -- reports that via `emit('error')`. EventEmitter rethrows an
 * `error` with no listener; because the emit happens inside a `.catch()`
 * callback, that surfaces as an unhandled promise rejection and the fatal
 * handler exits the process. A caller that only attaches its listener after
 * a successful connect, or detaches it in its connect-failure path, has
 * nothing listening at that moment.
 *
 * Callers should attach their own `error` listeners as well; this sink only
 * guarantees one is always present so a late error on a discarded client
 * can never crash the process.
 */
export const ignoreLateImapErrors = <
  C extends { on: (event: 'error', listener: (err: Error) => void) => unknown }
>(
  client: C
): C => {
  client.on('error', () => undefined);
  return client;
};

export type CreateConnectedImapClientOptions = {
  ImapClientCtor?: ImapClientConstructor;
};

export const createConnectedImapClient = async (
  account: AccountConfig,
  options: CreateConnectedImapClientOptions = {}
): Promise<{ client: ImapClient; close: () => Promise<void> }> => {
  const ImapClientCtor =
    options.ImapClientCtor ?? (ImapFlow as ImapClientConstructor);
  const client = ignoreLateImapErrors(
    new ImapClientCtor({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: {
        user: account.auth.user,
        pass: account.auth.pass
      }
    })
  );

  try {
    await client.connect();
  } catch (error) {
    throw new ImapConnectionError(
      `Failed to connect to IMAP account "${account.id}"`,
      { cause: error as Error }
    );
  }

  // ImapFlow extends EventEmitter and rethrows an `error` event with no
  // listener as an uncaught exception. This client is short-lived and its
  // caller drives operations directly against it, so there's no in-flight
  // promise to reject here -- registering a listener is enough to turn a
  // mid-operation socket reset into a failed command (ImapFlow rejects the
  // pending command itself) instead of a process crash.
  const handleError = (): void => undefined;
  client.on('error', handleError);

  return {
    client,
    close: async () => {
      client.off('error', handleError);
      try {
        await client.logout();
      } catch {
        // Intentionally ignored: safe-close helper should never throw.
      }
    }
  };
};
