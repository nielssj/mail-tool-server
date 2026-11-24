import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWatcher } from '../src/imap/watcher.js';

// A minimal IMAP server whose IDLE never delivers anything: it acknowledges
// IDLE, then only sends its own "still here" keep-alive lines -- the shape
// of the 2026-11-20 to 2026-11-22 outage, where the watcher stayed
// "connected" for ~60h while new mail went unnoticed. Keep-alive traffic
// also keeps the client's socket timeout from firing, so the only thing
// that can end this IDLE is the client's own maxIdleTime.
const startSilentIdleServer = async () => {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let keepAlive: NodeJS.Timeout | undefined;
    let idleTag: string | undefined;
    socket.on('error', () => undefined);
    socket.write('* OK [CAPABILITY IMAP4rev1 IDLE] ready\r\n');
    socket.on('data', (data) => {
      for (const line of data.toString().split('\r\n').filter(Boolean)) {
        if (line === 'DONE' && idleTag) {
          clearInterval(keepAlive);
          commands.push('DONE');
          socket.write(`${idleTag} OK IDLE terminated\r\n`);
          idleTag = undefined;
          continue;
        }
        const [tag, rawCommand = ''] = line.split(' ');
        const command = rawCommand.toUpperCase();
        commands.push(command);
        switch (command) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK done\r\n`);
            break;
          case 'SELECT':
          case 'EXAMINE':
            socket.write(
              '* 0 EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen)\r\n' +
                '* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n' +
                `${tag} OK [READ-WRITE] done\r\n`
            );
            break;
          case 'IDLE':
            idleTag = tag;
            socket.write('+ idling\r\n');
            keepAlive = setInterval(() => socket.write('* OK still here\r\n'), 20);
            break;
          case 'LOGOUT':
            socket.end(`* BYE bye\r\n${tag} OK done\r\n`);
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on('close', () => clearInterval(keepAlive));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, commands, close };
};

describe('AccountWatcher IDLE refresh (real ImapFlow)', () => {
  let fake: Awaited<ReturnType<typeof startSilentIdleServer>>;

  beforeEach(async () => {
    fake = await startSilentIdleServer();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('ends and re-issues IDLE every maxIdleTimeMs even while the server keeps the socket busy', async () => {
    const watcher = new AccountWatcher(
      {
        id: 'acc-1',
        host: '127.0.0.1',
        port: (fake.server.address() as net.AddressInfo).port,
        secure: false,
        auth: { user: 'user', pass: 'pass' },
        watchMailboxes: ['INBOX'],
        dispatchers: []
      },
      { maxIdleTimeMs: 100 }
    );

    try {
      await watcher.start();
      await vi.waitFor(
        () => {
          expect(fake.commands.filter((c) => c === 'IDLE').length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 3000 }
      );
      // Each re-issue is preceded by a DONE ending the previous IDLE.
      expect(fake.commands.filter((c) => c === 'DONE').length).toBeGreaterThanOrEqual(2);
      expect(watcher.isConnected()).toBe(true);
    } finally {
      await watcher.stop();
    }
  });
});
