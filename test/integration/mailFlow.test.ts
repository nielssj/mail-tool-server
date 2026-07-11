import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ImapFlow } from 'imapflow';
import {
  GenericContainer,
  Wait,
  type StartedTestContainer
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AccountWatcher } from '../../src/imap/watcher.js';
import { createDispatcher, subscribeWatcher } from '../../src/events/dispatcher.js';
import { createMailboxService } from '../../src/services/mailboxService.js';
import type { AccountConfig } from '../../src/utils/config/schema.js';
import type { DomainEvent } from '../../src/events/types.js';

// GreenMail standalone: in-memory SMTP+IMAP test server.
// Pinned tag (not :latest) for reproducibility — see task note.
const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.0';
const GREENMAIL_IMAP_PORT = 3143;
const USER = 'alice@example.com';
const PASS = 'password';

const rawMessage = (subject: string, body: string): string =>
  [
    `From: sender@example.com`,
    `To: ${USER}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.com>`,
    ``,
    body,
    ``
  ].join('\r\n');

const makeAccount = (host: string, port: number): AccountConfig => ({
  id: 'it-account',
  host,
  port,
  secure: false,
  auth: { user: USER, pass: PASS },
  watchMailboxes: ['INBOX'],
  dispatchers: []
});

const connectClient = async (host: string, port: number): Promise<ImapFlow> => {
  const client = new ImapFlow({
    host,
    port,
    secure: false,
    auth: { user: USER, pass: PASS },
    logger: false
  });
  await client.connect();
  return client;
};

describe('integration: real IMAP flow against GreenMail', () => {
  let container: StartedTestContainer;
  let host: string;
  let port: number;

  // In-test webhook receiver capturing dispatched POST bodies.
  let webhookServer: http.Server;
  let webhookUrl: string;
  const received: DomainEvent[] = [];

  const waitForEvent = async (
    predicate: (event: DomainEvent) => boolean,
    timeoutMs = 30_000
  ): Promise<DomainEvent> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = received.find(predicate);
      if (found) {
        return found;
      }
      await delay(200);
    }
    throw new Error('Timed out waiting for expected webhook event');
  };

  beforeAll(async () => {
    container = await new GenericContainer(GREENMAIL_IMAGE)
      // auth.disabled lets us log in / auto-provision users without pre-seeding.
      .withEnvironment({
        GREENMAIL_OPTS:
          '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled'
      })
      .withExposedPorts(GREENMAIL_IMAP_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    host = container.getHost();
    port = container.getMappedPort(GREENMAIL_IMAP_PORT);

    // Start the webhook receiver.
    webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          received.push(JSON.parse(body) as DomainEvent);
        } catch {
          // Ignore malformed bodies — the test asserts on parsed events only.
        }
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      webhookServer.listen(0, '127.0.0.1', resolve);
    });
    const address = webhookServer.address() as AddressInfo;
    webhookUrl = `http://127.0.0.1:${address.port}/hook`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    await container.stop();
  });

  it('drives list → get → flag → move and receives a real IDLE webhook', async () => {
    // Seed: create the destination mailbox and append one initial message,
    // via a throwaway imapflow client (real IMAP APPEND, no mocking).
    const seed = await connectClient(host, port);
    await seed.mailboxCreate('Archive');
    await seed.append('INBOX', rawMessage('First message', 'hello world'), ['\\Seen']);
    await seed.logout();

    // Build the real app + watcher against the container.
    const account = makeAccount(host, port);
    const mailboxService = createMailboxService([account]);
    const watcher = new AccountWatcher(account, { reconnectDelayMs: 500 });

    // Wire the watcher's real IDLE events to a webhook dispatcher pointed at
    // the in-test receiver — the part a mocked IMAP layer can never validate.
    const dispatcher = createDispatcher({ type: 'webhook', url: webhookUrl });
    subscribeWatcher(watcher, [dispatcher]);

    const app = await buildApp({
      loggerConfig: { env: 'test' },
      watchers: [watcher],
      mailboxService
    });

    await watcher.start();

    try {
      // 1. List mailboxes — INBOX and Archive must be present.
      const mailboxesRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes`
      });
      expect(mailboxesRes.statusCode).toBe(200);
      const mailboxPaths = (mailboxesRes.json() as Array<{ path: string }>).map(
        (m) => m.path
      );
      expect(mailboxPaths).toContain('INBOX');
      expect(mailboxPaths).toContain('Archive');

      // 2. List messages — the seeded message is there.
      const listRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes/INBOX/messages`
      });
      expect(listRes.statusCode).toBe(200);
      const messages = listRes.json() as Array<{
        uid: number;
        envelope: { subject: string };
      }>;
      expect(messages.length).toBe(1);
      const uid = messages[0]!.uid;
      expect(messages[0]!.envelope.subject).toBe('First message');

      // 3. Get the single message by uid.
      const getRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes/INBOX/messages/${uid}`
      });
      expect(getRes.statusCode).toBe(200);
      expect((getRes.json() as { uid: number }).uid).toBe(uid);

      // 4. Flag the message.
      const flagRes = await app.inject({
        method: 'POST',
        url: `/accounts/${account.id}/mailboxes/INBOX/messages/${uid}/flags`,
        payload: { add: ['\\Flagged'] }
      });
      expect(flagRes.statusCode).toBe(200);
      expect(flagRes.json()).toEqual({ ok: true });

      // 5. Move the message to Archive, then verify it landed there.
      const moveRes = await app.inject({
        method: 'POST',
        url: `/accounts/${account.id}/mailboxes/INBOX/messages/${uid}/move`,
        payload: { destination: 'Archive' }
      });
      expect(moveRes.statusCode).toBe(200);
      expect(moveRes.json()).toEqual({ ok: true });

      const archiveRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes/Archive/messages`
      });
      expect(archiveRes.statusCode).toBe(200);
      expect((archiveRes.json() as unknown[]).length).toBe(1);

      // 6. Webhook assertion: append a fresh message while the watcher idles
      //    on INBOX and assert a real newMail event reaches the receiver.
      const appender = await connectClient(host, port);
      await appender.append('INBOX', rawMessage('Second message', 'incoming'));
      await appender.logout();

      const event = await waitForEvent(
        (e) => e.event === 'newMail' && e.mailbox === 'INBOX'
      );
      expect(event.accountId).toBe(account.id);
      expect(event.event).toBe('newMail');
      if (event.event === 'newMail') {
        expect(event.data.count).toBeGreaterThan(event.data.previousCount);
      }
      expect(typeof event.timestamp).toBe('string');
    } finally {
      await app.close();
    }
  });
});
