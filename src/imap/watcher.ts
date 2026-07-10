import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../utils/config/schema.js';
import type {
  FlagsChangedEvent,
  MailRemovedEvent,
  NewMailEvent
} from '../events/types.js';

type WatcherClientOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  logger?: false;
};

type MailboxOpenResult = {
  exists?: number;
};

type FlagsUpdate = {
  uid: number;
  flags?: Iterable<string>;
};

type ExpungeUpdate = {
  uid?: number;
  seq?: number;
};

type WatcherClientEvents = {
  close: () => void;
  exists: (count: number) => void;
  flags: (update: FlagsUpdate) => void;
  expunge: (update: ExpungeUpdate) => void;
};

export type WatcherClient = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  mailboxOpen: (path: string) => Promise<MailboxOpenResult>;
  idle: () => Promise<void>;
  on: <T extends keyof WatcherClientEvents>(
    event: T,
    listener: WatcherClientEvents[T]
  ) => WatcherClient;
  off: <T extends keyof WatcherClientEvents>(
    event: T,
    listener: WatcherClientEvents[T]
  ) => WatcherClient;
};

export type WatcherClientConstructor = new (
  options: WatcherClientOptions
) => WatcherClient;

export type WatcherLogger = {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type AccountWatcherOptions = {
  WatcherClientCtor?: WatcherClientConstructor;
  reconnectDelayMs?: number;
  now?: () => Date;
  logger?: WatcherLogger;
};

type AccountWatcherEvents = {
  newMail: (event: NewMailEvent) => void;
  flagsChanged: (event: FlagsChangedEvent) => void;
  mailRemoved: (event: MailRemovedEvent) => void;
};

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const noopLogger: WatcherLogger = {
  warn: () => undefined,
  error: () => undefined
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const normalizeFlags = (flags?: Iterable<string>): string[] =>
  flags ? Array.from(flags) : [];

export class AccountWatcher extends EventEmitter {
  private readonly WatcherClientCtor: WatcherClientConstructor;

  private readonly reconnectDelayMs: number;

  private readonly now: () => Date;

  private readonly logger: WatcherLogger;

  private readonly mailboxCounts = new Map<string, number>();

  private client?: WatcherClient;

  private reconnectTimer?: NodeJS.Timeout;

  private started = false;

  private activeMailboxIndex = 0;

  private activeMailbox?: string;

  constructor(
    private readonly account: AccountConfig,
    options: AccountWatcherOptions = {}
  ) {
    super();
    this.WatcherClientCtor =
      options.WatcherClientCtor ?? (ImapFlow as unknown as WatcherClientConstructor);
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? noopLogger;
  }

  override on<T extends keyof AccountWatcherEvents>(
    event: T,
    listener: AccountWatcherEvents[T]
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(
    event: string | symbol,
    listener: (...args: unknown[]) => void
  ): this {
    return super.on(event, listener);
  }

  override emit<T extends keyof AccountWatcherEvents>(
    event: T,
    ...args: Parameters<AccountWatcherEvents[T]>
  ): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      await this.connectAndWatch();
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.activeMailbox = undefined;
    this.mailboxCounts.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const client = this.client;
    this.client = undefined;

    if (!client) {
      return;
    }

    this.detachClientListeners(client);
    try {
      await client.logout();
    } catch {
      // Best-effort shutdown.
    }
  }

  private async connectAndWatch(): Promise<void> {
    const client = new this.WatcherClientCtor({
      host: this.account.host,
      port: this.account.port,
      secure: this.account.secure,
      auth: {
        user: this.account.auth.user,
        pass: this.account.auth.pass
      },
      logger: false
    });

    this.attachClientListeners(client);

    try {
      await client.connect();
      this.client = client;
      if (!this.started) {
        await this.stop();
        return;
      }

      if (this.account.watchMailboxes.length === 0) {
        return;
      }

      this.activeMailboxIndex = 0;
      await this.openActiveMailbox();
      this.beginIdle();
    } catch (error) {
      this.detachClientListeners(client);
      try {
        await client.logout();
      } catch {
        // Best-effort cleanup.
      }
      throw toError(error);
    }
  }

  private async openActiveMailbox(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    const mailbox = this.account.watchMailboxes[this.activeMailboxIndex];
    if (!mailbox) {
      return;
    }

    this.activeMailbox = mailbox;

    const result = await client.mailboxOpen(mailbox);
    const exists =
      typeof result.exists === 'number'
        ? result.exists
        : (this.mailboxCounts.get(mailbox) ?? 0);
    this.mailboxCounts.set(mailbox, exists);
  }

  private beginIdle(): void {
    const client = this.client;
    if (!client || !this.started || !this.activeMailbox) {
      return;
    }

    void client
      .idle()
      .then(async () => {
        if (!this.started || client !== this.client) {
          return;
        }

        if (this.account.watchMailboxes.length <= 1) {
          this.beginIdle();
          return;
        }

        this.activeMailboxIndex =
          (this.activeMailboxIndex + 1) % this.account.watchMailboxes.length;

        try {
          await this.openActiveMailbox();
          this.beginIdle();
        } catch (error) {
          this.logger.error(
            error,
            `Failed to open mailbox for account "${this.account.id}"`
          );
          this.handleConnectionDrop();
        }
      })
      .catch((error) => {
        if (!this.started || client !== this.client) {
          return;
        }

        this.logger.error(
          error,
          `IDLE loop failed for account "${this.account.id}"`
        );
        this.handleConnectionDrop();
      });
  }

  private handleExists = (count: number): void => {
    const mailbox = this.activeMailbox;
    if (!mailbox) {
      return;
    }

    const previousCount = this.mailboxCounts.get(mailbox) ?? 0;
    this.mailboxCounts.set(mailbox, count);

    if (count <= previousCount) {
      return;
    }

    this.emit('newMail', {
      event: 'newMail',
      accountId: this.account.id,
      mailbox,
      data: {
        count,
        previousCount
      },
      timestamp: this.now().toISOString()
    });
  };

  private handleFlags = (update: FlagsUpdate): void => {
    const mailbox = this.activeMailbox;
    if (!mailbox) {
      return;
    }

    this.emit('flagsChanged', {
      event: 'flagsChanged',
      accountId: this.account.id,
      mailbox,
      data: {
        uid: update.uid,
        flags: normalizeFlags(update.flags)
      },
      timestamp: this.now().toISOString()
    });
  };

  private handleExpunge = (update: ExpungeUpdate): void => {
    const mailbox = this.activeMailbox;
    if (!mailbox) {
      return;
    }

    const previousCount = this.mailboxCounts.get(mailbox);
    if (previousCount != null) {
      this.mailboxCounts.set(mailbox, Math.max(0, previousCount - 1));
    }

    this.emit('mailRemoved', {
      event: 'mailRemoved',
      accountId: this.account.id,
      mailbox,
      data: {
        uid: update.uid,
        seq: update.seq
      },
      timestamp: this.now().toISOString()
    });
  };

  private handleClose = (): void => {
    if (!this.started) {
      return;
    }

    this.handleConnectionDrop();
  };

  private handleConnectionDrop(): void {
    const client = this.client;
    this.client = undefined;
    this.activeMailbox = undefined;
    this.mailboxCounts.clear();

    if (client) {
      this.detachClientListeners(client);
      void client.logout().catch(() => undefined);
    }

    if (!this.started || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.started) {
        return;
      }

      void this.reconnect();
    }, this.reconnectDelayMs);
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connectAndWatch();
    } catch (error) {
      this.logger.warn(
        error,
        `Failed to reconnect watcher for account "${this.account.id}"`
      );
      this.handleConnectionDrop();
    }
  }

  private attachClientListeners(client: WatcherClient): void {
    client.on('exists', this.handleExists);
    client.on('flags', this.handleFlags);
    client.on('expunge', this.handleExpunge);
    client.on('close', this.handleClose);
  }

  private detachClientListeners(client: WatcherClient): void {
    client.off('exists', this.handleExists);
    client.off('flags', this.handleFlags);
    client.off('expunge', this.handleExpunge);
    client.off('close', this.handleClose);
  }
}
