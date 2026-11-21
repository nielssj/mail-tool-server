import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { SafeImapFlow } from '../src/imap/safeImapFlow.js';

// A minimal IMAP server that reproduces the production failure: it answers
// the greeting and CAPABILITY, then -- like a provider enforcing a
// per-account connection limit -- replies to the next command (LOGIN) with
// an untagged BYE and closes the socket mid-handshake.
const startConnectionLimitServer = async (): Promise<net.Server> => {
  const server = net.createServer((socket) => {
    socket.write('* OK ready\r\n');
    socket.on('data', (data) => {
      const line = data.toString();
      const tag = line.split(' ')[0];
      if (/CAPABILITY/i.test(line)) {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
      } else {
        socket.end('* BYE Too many simultaneous connections for your account.\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

const clientOptions = (server: net.Server) => ({
  host: '127.0.0.1',
  port: (server.address() as net.AddressInfo).port,
  secure: false,
  auth: { user: 'user', pass: 'pass' },
  logger: false as const
});

describe('SafeImapFlow', () => {
  let server: net.Server;

  beforeEach(async () => {
    server = await startConnectionLimitServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('upstream canary: bare ImapFlow emits "error" on top of rejecting connect()', async () => {
    // Documents the ImapFlow behavior SafeImapFlow exists for: the failed
    // handshake is reported twice -- once by rejecting connect(), and again
    // by an 'error' emit from the detached startSession() chain, which
    // runs after close() has already settled the connect promise
    // internally (it can still land before the caller's await resumes).
    // If this starts failing after an imapflow upgrade, the duplicate emit
    // has been fixed upstream and SafeImapFlow can likely be removed.
    const client = new ImapFlow(clientOptions(server));
    const errorListener = vi.fn();
    client.on('error', errorListener);

    await expect(client.connect()).rejects.toThrow('Unexpected close');
    await vi.waitFor(() => expect(errorListener).toHaveBeenCalled());
  });

  it('survives that late "error" with no caller-attached listener', async () => {
    const client = new SafeImapFlow(clientOptions(server));
    const emit = vi.spyOn(client, 'emit');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await expect(client.connect()).rejects.toThrow('Unexpected close');

      // The late error must actually have been emitted for this to prove
      // anything -- without SafeImapFlow's sink, this emit is the call
      // that throws and becomes an unhandled rejection.
      await vi.waitFor(() =>
        expect(emit.mock.calls.some(([event]) => event === 'error')).toBe(true)
      );
      // Give any rejection a turn to surface before asserting there was none.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still delivers errors to listeners callers attach themselves', () => {
    const client = new SafeImapFlow(clientOptions(server));
    const listener = vi.fn();
    client.on('error', listener);

    const err = new Error('read ECONNRESET');
    client.emit('error', err);

    expect(listener).toHaveBeenCalledWith(err);
  });
});
