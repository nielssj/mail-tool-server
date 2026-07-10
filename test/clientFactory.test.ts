import { describe, it, expect, vi } from 'vitest';
import {
  createConnectedImapClient,
  ImapConnectionError,
  type ImapClientConstructor
} from '../src/imap/clientFactory.js';

const ACCOUNT = {
  id: 'account-1',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: {
    user: 'user@example.com',
    pass: 'password'
  },
  watchMailboxes: ['INBOX'],
  dispatchers: []
};

describe('createConnectedImapClient', () => {
  it('creates a client with account credentials, connects, and closes with logout', async () => {
    const connect = vi.fn(async () => undefined);
    const logout = vi.fn(async () => undefined);
    const ctorSpy = vi.fn();
    class MockImapClient {
      constructor(options: unknown) {
        ctorSpy(options);
      }
      connect = connect;
      logout = logout;
    }

    const { close } = await createConnectedImapClient(ACCOUNT, {
      ImapClientCtor: MockImapClient as unknown as ImapClientConstructor
    });

    expect(ctorSpy).toHaveBeenCalledWith({
      host: ACCOUNT.host,
      port: ACCOUNT.port,
      secure: ACCOUNT.secure,
      auth: ACCOUNT.auth
    });
    expect(connect).toHaveBeenCalledTimes(1);

    await close();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('rethrows connect failures as ImapConnectionError', async () => {
    const connectFailure = new Error('socket timeout');
    const connect = vi.fn(async () => {
      throw connectFailure;
    });
    const logout = vi.fn(async () => undefined);
    class MockImapClient {
      connect = connect;
      logout = logout;
    }

    await expect(
      createConnectedImapClient(ACCOUNT, {
        ImapClientCtor: MockImapClient as unknown as ImapClientConstructor
      })
    ).rejects.toBeInstanceOf(ImapConnectionError);

    await expect(
      createConnectedImapClient(ACCOUNT, {
        ImapClientCtor: MockImapClient as unknown as ImapClientConstructor
      })
    ).rejects.toMatchObject({
      cause: connectFailure
    });
  });

  it('close helper does not throw when logout fails', async () => {
    const connect = vi.fn(async () => undefined);
    const logout = vi.fn(async () => {
      throw new Error('logout failed');
    });
    class MockImapClient {
      connect = connect;
      logout = logout;
    }

    const { close } = await createConnectedImapClient(ACCOUNT, {
      ImapClientCtor: MockImapClient as unknown as ImapClientConstructor
    });

    await expect(close()).resolves.toBeUndefined();
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
