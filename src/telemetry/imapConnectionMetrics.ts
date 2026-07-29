import type { MailboxClient, MailboxClientConstructor } from '../services/mailboxService.js';
import * as telemetry from './instruments.js';

type MailboxClientOptions = ConstructorParameters<MailboxClientConstructor>[0];

/**
 * Decorates a MailboxClientConstructor to record
 * mailtool.imap.connection.duration / mailtool.imap.connection.errors
 * around connect(), without mailboxService.ts (or the underlying IMAP
 * client) needing any telemetry awareness. Every other MailboxClient method
 * is delegated to the wrapped client unchanged. Intended to be applied once
 * at the composition root (server.ts):
 * `createMailboxService(accounts, { MailboxClientCtor: withConnectionMetrics(ImapFlow) })`.
 */
export const withConnectionMetrics = (ctor: MailboxClientConstructor): MailboxClientConstructor => {
  class InstrumentedMailboxClient implements MailboxClient {
    private readonly inner: MailboxClient;

    private readonly accountId: string;

    constructor(options: MailboxClientOptions) {
      this.accountId = options.id;
      this.inner = new ctor(options);
    }

    async connect(): Promise<void> {
      const start = performance.now();
      try {
        await this.inner.connect();
      } catch (error) {
        telemetry.imapConnectionDuration.record((performance.now() - start) / 1000, {
          'account.id': this.accountId,
          outcome: 'error'
        });
        telemetry.imapConnectionErrors.add(1, { 'account.id': this.accountId });
        throw error;
      }
      telemetry.imapConnectionDuration.record((performance.now() - start) / 1000, {
        'account.id': this.accountId,
        outcome: 'ok'
      });
    }

    logout(): ReturnType<MailboxClient['logout']> {
      return this.inner.logout();
    }

    list(): ReturnType<MailboxClient['list']> {
      return this.inner.list();
    }

    mailboxOpen(...args: Parameters<MailboxClient['mailboxOpen']>): ReturnType<MailboxClient['mailboxOpen']> {
      return this.inner.mailboxOpen(...args);
    }

    fetchAll(...args: Parameters<MailboxClient['fetchAll']>): ReturnType<MailboxClient['fetchAll']> {
      return this.inner.fetchAll(...args);
    }

    fetchOne(...args: Parameters<MailboxClient['fetchOne']>): ReturnType<MailboxClient['fetchOne']> {
      return this.inner.fetchOne(...args);
    }

    download(...args: Parameters<MailboxClient['download']>): ReturnType<MailboxClient['download']> {
      return this.inner.download(...args);
    }

    messageMove(...args: Parameters<MailboxClient['messageMove']>): ReturnType<MailboxClient['messageMove']> {
      return this.inner.messageMove(...args);
    }

    messageFlagsAdd(
      ...args: Parameters<MailboxClient['messageFlagsAdd']>
    ): ReturnType<MailboxClient['messageFlagsAdd']> {
      return this.inner.messageFlagsAdd(...args);
    }

    messageFlagsRemove(
      ...args: Parameters<MailboxClient['messageFlagsRemove']>
    ): ReturnType<MailboxClient['messageFlagsRemove']> {
      return this.inner.messageFlagsRemove(...args);
    }

    append(...args: Parameters<MailboxClient['append']>): ReturnType<MailboxClient['append']> {
      return this.inner.append(...args);
    }
  }

  return InstrumentedMailboxClient as unknown as MailboxClientConstructor;
};
