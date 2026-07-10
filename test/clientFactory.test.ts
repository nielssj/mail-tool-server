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

const prepareImapMock = ({
  connectImpl = async () => undefined,
  logoutImpl = async () => undefined,
  withCtorSpy = false
}: {
  connectImpl?: () => Promise<void>;
  logoutImpl?: () => Promise<void>;
  withCtorSpy?: boolean;
}) => {
  const connect = vi.fn(connectImpl);
  const logout = vi.fn(logoutImpl);
  const ctorSpy = vi.fn();

  class MockImapClient {
    constructor(options: unknown) {
      if (withCtorSpy) {
        ctorSpy(options);
      }
    }
    connect = connect;
    logout = logout;
  }

  return {
    connect,
    logout,
    ctorSpy,
    ImapClientCtor: MockImapClient as unknown as ImapClientConstructor
  };
};

describe('createConnectedImapClient', () => {
  it('creates a client with account credentials, connects, and closes with logout', async () => {
    const { connect, logout, ctorSpy, ImapClientCtor } = prepareImapMock({
      withCtorSpy: true
    });

    const { close } = await createConnectedImapClient(ACCOUNT, {
      ImapClientCtor
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
    const { ImapClientCtor } = prepareImapMock({
      connectImpl: async () => {
        throw connectFailure;
      }
    });

    await expect(
      createConnectedImapClient(ACCOUNT, {
        ImapClientCtor
      })
    ).rejects.toBeInstanceOf(ImapConnectionError);

    await expect(
      createConnectedImapClient(ACCOUNT, {
        ImapClientCtor
      })
    ).rejects.toMatchObject({
      cause: connectFailure
    });
  });

  it('close helper does not throw when logout fails', async () => {
    const { logout, ImapClientCtor } = prepareImapMock({
      logoutImpl: async () => {
        throw new Error('logout failed');
      }
    });

    const { close } = await createConnectedImapClient(ACCOUNT, {
      ImapClientCtor
    });

    await expect(close()).resolves.toBeUndefined();
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
