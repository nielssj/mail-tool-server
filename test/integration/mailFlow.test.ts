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
const GREENMAIL_API_PORT = 8080;
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

const describeError = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const e = error as {
      message?: string;
      executedCommand?: string;
      responseStatus?: string;
      responseText?: string;
    };
    return [
      e.message ?? String(error),
      e.executedCommand ? `cmd=${e.executedCommand}` : undefined,
      e.responseStatus ? `status=${e.responseStatus}` : undefined,
      e.responseText ? `text=${e.responseText}` : undefined
    ]
      .filter(Boolean)
      .join(' | ');
  }
  return String(error);
};

const dumpContainerLogs = async (
  target: StartedTestContainer
): Promise<void> => {
  try {
    const stream = await target.logs();
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      stream.on('data', (chunk) => chunks.push(chunk.toString()));
      stream.on('end', done);
      stream.on('err', done);
      setTimeout(done, 3_000);
    });
    console.error('--- GreenMail container logs ---\n' + chunks.join(''));
  } catch {
    // Best-effort diagnostics only.
  }
};

const makeAccount = (host: string, port: number): AccountConfig => ({
  id: 'it-account',
  host,
  port,
  secure: false,
  auth: { user: USER, pass: PASS },
  watchMailboxes: ['INBOX'],
  dispatchers: []
});

const makeAccountWithMailboxes = (
  host: string,
  port: number,
  id: string,
  watchMailboxes: string[]
): AccountConfig => ({
  id,
  host,
  port,
  secure: false,
  auth: { user: USER, pass: PASS },
  watchMailboxes,
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
      .withEnvironment({
        GREENMAIL_OPTS:
          '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0'
      })
      .withExposedPorts(GREENMAIL_IMAP_PORT, GREENMAIL_API_PORT)
      // GreenMail's standalone REST API exposes a readiness probe — a more
      // reliable signal than a raw port check that the server can serve.
      .withWaitStrategy(
        Wait.forHttp('/api/service/readiness', GREENMAIL_API_PORT).forStatusCode(
          200
        )
      )
      .start();

    host = container.getHost();
    port = container.getMappedPort(GREENMAIL_IMAP_PORT);

    // GreenMail does not auto-provision IMAP users; create the account via the
    // standalone REST API before any IMAP login.
    const apiPort = container.getMappedPort(GREENMAIL_API_PORT);
    const createUserRes = await fetch(`http://${host}:${apiPort}/api/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER, login: USER, password: PASS })
    });
    if (!createUserRes.ok && createUserRes.status !== 409) {
      throw new Error(
        `Failed to provision GreenMail user: HTTP ${createUserRes.status} ${await createUserRes.text()}`
      );
    }

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
    try {
      await runFlow();
    } catch (error) {
      await dumpContainerLogs(container);
      throw new Error(describeError(error), { cause: error });
    }
  });

  const runFlow = async (): Promise<void> => {
    // Seed: create the destination mailbox and append one initial message,
    // via a throwaway imapflow client (real IMAP APPEND, no mocking).
    const seed = await connectClient(host, port);
    await seed.mailboxCreate('Archive');
    await seed.mailboxCreate('Drafts');
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
        subject?: string;
      }>;
      expect(messages.length).toBe(1);
      const uid = messages[0]!.uid;
      expect(messages[0]!.subject).toBe('First message');
      // List items are deliberately minimal -- no flags/body/attachments.
      expect(messages[0]).not.toHaveProperty('flags');
      expect(messages[0]).not.toHaveProperty('body');

      // 3. Get the single message by uid -- the clean detail projection,
      // with a real decoded body and no ImapFlow-native fields (source,
      // bodyStructure, ...) leaking onto the wire.
      const getRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes/INBOX/messages/${uid}`
      });
      expect(getRes.statusCode).toBe(200);
      const detail = getRes.json() as { uid: number; subject?: string; body: string };
      expect(detail.uid).toBe(uid);
      expect(detail.subject).toBe('First message');
      expect(detail.body).toContain('hello world');
      expect(detail).not.toHaveProperty('source');
      expect(detail).not.toHaveProperty('bodyStructure');

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

      // 6. Create a draft via IMAP APPEND (real MIME composition, real
      //    server-side round-trip -- not a mock), then verify it landed in
      //    Drafts with the right subject/body and the \Draft flag set.
      const draftRes = await app.inject({
        method: 'POST',
        url: `/accounts/${account.id}/mailboxes/Drafts/drafts`,
        payload: {
          to: ['someone@example.com'],
          subject: 'Draft subject',
          text: 'Draft body text'
        }
      });
      expect(draftRes.statusCode).toBe(200);
      const draft = draftRes.json() as { mailbox: string; uid?: number };
      expect(draft.mailbox).toBe('Drafts');

      const draftsListRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes/Drafts/messages`
      });
      expect(draftsListRes.statusCode).toBe(200);
      const draftMessages = draftsListRes.json() as Array<{ uid: number; subject?: string }>;
      expect(draftMessages.length).toBe(1);
      expect(draftMessages[0]!.subject).toBe('Draft subject');

      const draftUid = draft.uid ?? draftMessages[0]!.uid;
      const draftDetailRes = await app.inject({
        method: 'GET',
        url: `/accounts/${account.id}/mailboxes/Drafts/messages/${draftUid}`
      });
      expect(draftDetailRes.statusCode).toBe(200);
      const draftDetail = draftDetailRes.json() as { body: string; flags: string[] };
      expect(draftDetail.body).toContain('Draft body text');
      expect(draftDetail.flags).toContain('\\Draft');

      // 7. Webhook assertion: append a fresh message while the watcher idles
      //    on INBOX and assert a real newMail event reaches the receiver,
      //    carrying the message's real UID (from IMAP APPEND's own UIDPLUS
      //    response, not just inferred).
      const appender = await connectClient(host, port);
      const appended = await appender.append('INBOX', rawMessage('Second message', 'incoming'));
      await appender.logout();
      if (!appended || typeof appended.uid !== 'number') {
        throw new Error('APPEND did not return a UID -- does GreenMail support UIDPLUS here?');
      }

      const event = await waitForEvent(
        (e) => e.event === 'newMail' && e.mailbox === 'INBOX'
      );
      expect(event.accountId).toBe(account.id);
      expect(event.event).toBe('newMail');
      if (event.event === 'newMail') {
        expect(event.data.uid).toBe(appended.uid);
        expect(event.data.count).toBeGreaterThan(0);
      }
      expect(typeof event.timestamp).toBe('string');
    } finally {
      await app.close();
    }
  };

  it('reports one newMail event per message, with correct UIDs, for a burst of simultaneous arrivals', async () => {
    try {
      await runBurstScenario();
    } catch (error) {
      await dumpContainerLogs(container);
      throw new Error(describeError(error), { cause: error });
    }
  });

  const runBurstScenario = async (): Promise<void> => {
    const mailbox = 'Burst';
    const seed = await connectClient(host, port);
    await seed.mailboxCreate(mailbox);
    await seed.logout();

    const account = makeAccountWithMailboxes(host, port, 'it-account-burst', [mailbox]);
    const watcher = new AccountWatcher(account, { reconnectDelayMs: 500 });
    const dispatcher = createDispatcher({ type: 'webhook', url: webhookUrl });
    subscribeWatcher(watcher, [dispatcher]);

    await watcher.start();

    try {
      const appender = await connectClient(host, port);
      const appended = await Promise.all([
        appender.append(mailbox, rawMessage('Burst 1', 'one')),
        appender.append(mailbox, rawMessage('Burst 2', 'two')),
        appender.append(mailbox, rawMessage('Burst 3', 'three'))
      ]);
      await appender.logout();

      const expectedUids = appended
        .map((res) => (res ? res.uid : undefined))
        .filter((uid): uid is number => typeof uid === 'number')
        .sort((a, b) => a - b);
      if (expectedUids.length !== 3) {
        throw new Error('one or more APPENDs did not return a UID -- does GreenMail support UIDPLUS here?');
      }

      // Poll rather than waitForEvent's single-match predicate -- this
      // scenario needs all 3 events, and a real server is free to deliver
      // a multi-message arrival as either one coalesced EXISTS jump or
      // several small ones (both are valid IMAP behavior), so there is no
      // single predicate to wait for up front the way the other scenarios
      // have. Either way this codebase must still end up emitting exactly
      // one newMail event per message, which is what's asserted below.
      const start = Date.now();
      let events: DomainEvent[] = [];
      while (Date.now() - start < 30_000) {
        events = received.filter((e) => e.event === 'newMail' && e.mailbox === mailbox);
        if (events.length >= 3) {
          break;
        }
        await delay(200);
      }

      expect(events).toHaveLength(3);
      const receivedUids = events
        .map((e) => (e.event === 'newMail' ? e.data.uid : undefined))
        .filter((uid): uid is number => typeof uid === 'number')
        .sort((a, b) => a - b);
      expect(receivedUids).toEqual(expectedUids);
    } finally {
      await watcher.stop();
    }
  };

  it('correctly attributes newMail events per mailbox when round-robining across two mailboxes', async () => {
    try {
      await runRoundRobinScenario();
    } catch (error) {
      await dumpContainerLogs(container);
      throw new Error(describeError(error), { cause: error });
    }
  });

  const runRoundRobinScenario = async (): Promise<void> => {
    const mailboxA = 'RRInboxA';
    const mailboxB = 'RRInboxB';
    const seed = await connectClient(host, port);
    await seed.mailboxCreate(mailboxA);
    await seed.mailboxCreate(mailboxB);
    await seed.logout();

    const account = makeAccountWithMailboxes(host, port, 'it-account-rr', [mailboxA, mailboxB]);
    const watcher = new AccountWatcher(account, { reconnectDelayMs: 500 });
    const dispatcher = createDispatcher({ type: 'webhook', url: webhookUrl });
    subscribeWatcher(watcher, [dispatcher]);

    await watcher.start();

    try {
      const appender = await connectClient(host, port);

      // The first message is what drives the watcher's round-robin from A
      // to B in the first place (IDLE only breaks on a real server event or
      // a command of our own -- our own enrichment fetch is that command).
      // A message that arrives in B before the watcher ever opens B would
      // be folded into that open's baseline and never reported, the same
      // accepted round-robin-gap limitation this repo already documents --
      // so this scenario deliberately waits for A's event, then gives the
      // round-robin continuation a moment to actually reach and open B,
      // before appending to B.
      const appendedA = await appender.append(mailboxA, rawMessage('RR A', 'a'));
      if (!appendedA || typeof appendedA.uid !== 'number') {
        throw new Error('append to mailbox A did not return a UID -- does GreenMail support UIDPLUS here?');
      }

      const eventA = await waitForEvent(
        (e) => e.event === 'newMail' && e.mailbox === mailboxA
      );
      expect(eventA.event).toBe('newMail');
      if (eventA.event === 'newMail') {
        expect(eventA.data.uid).toBe(appendedA.uid);
      }

      await delay(500);

      const appendedB = await appender.append(mailboxB, rawMessage('RR B', 'b'));
      if (!appendedB || typeof appendedB.uid !== 'number') {
        throw new Error('append to mailbox B did not return a UID -- does GreenMail support UIDPLUS here?');
      }

      const eventB = await waitForEvent(
        (e) => e.event === 'newMail' && e.mailbox === mailboxB
      );
      expect(eventB.event).toBe('newMail');
      if (eventB.event === 'newMail') {
        expect(eventB.data.uid).toBe(appendedB.uid);
      }

      await appender.logout();

      // No cross-contamination: A's event never claims to be in B and
      // vice versa -- the actual empirical test of the enrichment/
      // round-robin sequencing fix, something a mock can't prove.
      expect(eventA.mailbox).toBe(mailboxA);
      expect(eventB.mailbox).toBe(mailboxB);
    } finally {
      await watcher.stop();
    }
  };
});
