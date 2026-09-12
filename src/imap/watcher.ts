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
  uidNext?: number;
  uidValidity?: bigint;
};

type UidFetchResult = {
  uid: number;
};

// imapflow emits `exists` as an object ({ path, count, prevCount }). Older
// callers/mocks may emit the bare count as a number, so accept both shapes.
type ExistsUpdate = {
  path?: string;
  count: number;
  prevCount?: number;
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
  error: (err: Error) => void;
  exists: (update: ExistsUpdate | number) => void;
  flags: (update: FlagsUpdate) => void;
  expunge: (update: ExpungeUpdate) => void;
};

export type WatcherClient = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  mailboxOpen: (path: string) => Promise<MailboxOpenResult>;
  idle: () => Promise<void>;
  /** UID-only enrichment fetch for newly-arrived messages -- same primitive
   * mailboxService.ts's `sinceUid` option already uses, scoped down to just
   * UIDs since this is a cheap enrichment query, not a full message read. */
  fetchAll: (
    range: string,
    query: { uid: true },
    options: { uid: true }
  ) => Promise<UidFetchResult[]>;
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
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type AccountWatcherOptions = {
  WatcherClientCtor?: WatcherClientConstructor;
  /** Base delay for the exponential reconnect backoff. */
  reconnectDelayMs?: number;
  /** Cap on the backed-off reconnect delay. */
  maxReconnectDelayMs?: number;
  /** Consecutive failed reconnect attempts before escalating to an `error`
   * log. Resets on the next successful reconnect. */
  reconnectFailureThreshold?: number;
  now?: () => Date;
  logger?: WatcherLogger;
  /** Jitter source for the backoff delay, injectable for deterministic
   * tests. Defaults to `Math.random`. */
  random?: () => number;
};

type AccountWatcherEvents = {
  newMail: (event: NewMailEvent) => void;
  flagsChanged: (event: FlagsChangedEvent) => void;
  mailRemoved: (event: MailRemovedEvent) => void;
  /** Emitted once per reconnect attempt, right before it's made. */
  reconnecting: () => void;
};

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_FAILURE_THRESHOLD = 5;
/** Matches webhookDispatcher.ts's existing MAX_ATTEMPTS convention rather
 * than inventing a new retry policy for this second, unrelated call site. */
const FETCH_UID_ATTEMPTS = 2;
const noopLogger: WatcherLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error != null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const normalizeFlags = (flags?: Iterable<string>): string[] =>
  flags ? Array.from(flags) : [];

export class AccountWatcher extends EventEmitter {
  private readonly WatcherClientCtor: WatcherClientConstructor;

  private readonly reconnectDelayMs: number;

  private readonly maxReconnectDelayMs: number;

  private readonly reconnectFailureThreshold: number;

  private readonly random: () => number;

  private readonly now: () => Date;

  private readonly logger: WatcherLogger;

  private readonly mailboxCounts = new Map<string, number>();

  /** Highest UID already accounted for per mailbox -- the baseline the next
   * newMail enrichment fetch searches forward from. */
  private readonly mailboxUidWatermarks = new Map<string, number>();

  private readonly mailboxUidValidity = new Map<string, bigint>();

  private client?: WatcherClient;

  private reconnectTimer?: NodeJS.Timeout;

  /** Consecutive failed reconnect attempts in the current outage; reset on
   * a successful reconnect. Drives the escalation-to-`error` threshold. */
  private consecutiveFailures = 0;

  /** Total reconnect attempts made since the outage started; reset on a
   * successful reconnect. Reported in the recovery `info` log. */
  private reconnectAttempts = 0;

  /** Whether this outage has already produced its one escalation `error`
   * log -- prevents re-logging `error` on every attempt past the
   * threshold. */
  private escalated = false;

  /** When the current outage began, for the recovery log's duration. */
  private outageStartedAt?: Date;

  private started = false;

  private activeMailboxIndex = 0;

  private activeMailbox?: string;

  /** Chain of in-flight newMail enrichment work, so overlapping EXISTS
   * notifications within one IDLE session enrich strictly in order (each
   * reads the UID watermark only after the previous one advanced it), and
   * so beginIdle()'s round-robin continuation can await the latest link to
   * know enrichment for the current mailbox has fully settled before
   * switching mailboxes on the same connection. */
  private pendingEnrichment?: Promise<void>;

  constructor(
    private readonly account: AccountConfig,
    options: AccountWatcherOptions = {}
  ) {
    super();
    this.WatcherClientCtor =
      options.WatcherClientCtor ?? (ImapFlow as unknown as WatcherClientConstructor);
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.reconnectFailureThreshold =
      options.reconnectFailureThreshold ?? DEFAULT_RECONNECT_FAILURE_THRESHOLD;
    this.random = options.random ?? Math.random;
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
    this.mailboxUidWatermarks.clear();
    this.mailboxUidValidity.clear();
    this.pendingEnrichment = undefined;
    this.consecutiveFailures = 0;
    this.reconnectAttempts = 0;
    this.escalated = false;
    this.outageStartedAt = undefined;

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

  /** Whether this watcher currently holds a live IMAP connection. */
  isConnected(): boolean {
    return this.client != null;
  }

  /** Last-known message count for a watched mailbox, or undefined if the
   * watcher hasn't opened it yet (e.g. before start() completes, or after
   * stop()). */
  getMailboxMessageCount(mailbox: string): number | undefined {
    return this.mailboxCounts.get(mailbox);
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
    this.updateUidWatermark(mailbox, result);
  }

  /** Establishes (or resets) the UID baseline a mailbox's newMail
   * enrichment fetches search forward from. Resets on a mailbox's first
   * open (including after a reconnect, since stop()/handleConnectionDrop()
   * clear these maps -- "current state is the baseline, nothing new yet" is
   * the same accepted trade-off mailboxCounts already makes) and whenever
   * UIDVALIDITY changes for an already-known mailbox (e.g. a server-side
   * rebuild while a multi-mailbox account is round-robining elsewhere) --
   * previously-seen UIDs are meaningless once that happens. */
  private updateUidWatermark(mailbox: string, result: MailboxOpenResult): void {
    if (result.uidNext == null) {
      return;
    }

    const previousValidity = this.mailboxUidValidity.get(mailbox);
    const validityChanged =
      result.uidValidity != null &&
      previousValidity != null &&
      result.uidValidity !== previousValidity;

    if (result.uidValidity != null) {
      this.mailboxUidValidity.set(mailbox, result.uidValidity);
    }

    if (validityChanged || !this.mailboxUidWatermarks.has(mailbox)) {
      this.mailboxUidWatermarks.set(mailbox, result.uidNext - 1);
    }
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

        // Wait for any newMail enrichment still in flight for the mailbox
        // we were just idling on before doing anything else on this
        // connection -- IDLE and the enrichment FETCH share one connection,
        // and imapflow breaks IDLE for any other command run on it, so
        // client.idle() above can resolve while our own enrichment fetch is
        // still mid-flight. Without this await, round-robining to the next
        // mailbox (a SELECT/EXAMINE on the same connection) could race the
        // in-flight FETCH.
        await this.pendingEnrichment;

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
          // Debug, not error: this is a connection drop like any other --
          // the reconnect-supervision escalation policy (see
          // handleReconnectFailure) is what decides whether it's worth an
          // `error` log, not the event that triggered it.
          this.logger.debug(
            { accountId: this.account.id, err: toError(error) },
            `Failed to open mailbox for account "${this.account.id}"`
          );
          this.handleConnectionDrop();
        }
      })
      .catch((error) => {
        if (!this.started || client !== this.client) {
          return;
        }

        this.logger.debug(
          { accountId: this.account.id, err: toError(error) },
          `IDLE loop failed for account "${this.account.id}"`
        );
        this.handleConnectionDrop();
      });
  }

  private handleExists = (update: ExistsUpdate | number): void => {
    const mailbox = this.activeMailbox;
    if (!mailbox) {
      return;
    }

    const count = typeof update === 'number' ? update : update.count;
    const previousCount = this.mailboxCounts.get(mailbox) ?? 0;
    this.mailboxCounts.set(mailbox, count);

    if (count <= previousCount) {
      return;
    }

    // Chained, not fire-and-forget: if another EXISTS notification arrives
    // for this mailbox before the current enrichment settles, the next one
    // waits its turn instead of racing it for the same UID watermark.
    this.pendingEnrichment = (this.pendingEnrichment ?? Promise.resolve()).then(
      () => this.emitNewMail(mailbox, count)
    );
  };

  /** Fetches the UIDs of the messages that arrived since the mailbox's
   * tracked watermark and emits one newMail event per UID (ascending),
   * each carrying the same `count` -- the one total IMAP actually reported
   * for this EXISTS jump, never synthesized into a fake running total.
   * Never throws: a failed enrichment fetch (see fetchNewUids) logs and
   * simply skips this cycle rather than emitting a degraded event, since
   * every newMail event now requires a real uid. */
  private async emitNewMail(mailbox: string, count: number): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    const watermark = this.mailboxUidWatermarks.get(mailbox);
    if (watermark == null) {
      this.logger.warn(
        `No UID watermark for mailbox "${mailbox}" on account "${this.account.id}"; skipping newMail enrichment`
      );
      return;
    }

    const fetched = await this.fetchNewUids(client, watermark);
    if (fetched == null) {
      return;
    }

    // Defensive re-filter, not just trust: RFC 3501 leaves a "N:*" range
    // where N exceeds the highest existing UID ambiguous, and at least one
    // real server (found via the GreenMail-backed integration suite, not a
    // mock) interprets it as matching the last message instead of nothing
    // -- silently re-returning an already-reported UID rather than an empty
    // result. Never trust a fetch result to only contain genuinely-new
    // UIDs; always filter against the watermark ourselves.
    const uids = fetched.filter((uid) => uid > watermark);
    if (uids.length === 0) {
      return;
    }

    this.mailboxUidWatermarks.set(mailbox, uids[uids.length - 1]!);

    for (const uid of uids) {
      this.emit('newMail', {
        event: 'newMail',
        accountId: this.account.id,
        mailbox,
        data: { uid, count },
        timestamp: this.now().toISOString()
      });
    }
  }

  /** UID-only enrichment fetch with one retry (matches
   * webhookDispatcher.ts's MAX_ATTEMPTS=2 convention). Returns undefined,
   * having already logged, if every attempt fails -- callers treat that as
   * "skip this cycle," not a fatal error; the watermark stays put so a
   * later successful fetch naturally picks up the missed range. */
  private async fetchNewUids(
    client: WatcherClient,
    watermark: number
  ): Promise<number[] | undefined> {
    const range = `${watermark + 1}:*`;

    for (let attempt = 1; attempt <= FETCH_UID_ATTEMPTS; attempt += 1) {
      try {
        const results = await client.fetchAll(range, { uid: true }, { uid: true });
        return results.map((r) => r.uid).sort((a, b) => a - b);
      } catch (error) {
        if (attempt >= FETCH_UID_ATTEMPTS) {
          this.logger.error(
            toError(error),
            `Failed to fetch new message UIDs for account "${this.account.id}" after ${FETCH_UID_ATTEMPTS} attempts`
          );
        }
      }
    }

    return undefined;
  }

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

  /** Registered on every client so a socket error never reaches Node's
   * uncaught-exception handler (EventEmitter rethrows an `error` event with
   * no listener). `close` usually follows `error` -- handleConnectionDrop
   * is idempotent for that ordering: it nulls `this.client` and detaches
   * listeners synchronously, so a `close` that fires right after finds
   * nothing left to tear down and the `reconnectTimer` guard stops it from
   * scheduling a second reconnect. */
  private handleError = (error: unknown): void => {
    if (!this.started) {
      return;
    }

    this.logger.debug(
      { accountId: this.account.id, err: toError(error), code: errorCode(error) },
      `IMAP connection error for account "${this.account.id}"`
    );
    this.handleConnectionDrop();
  };

  private handleConnectionDrop(): void {
    const client = this.client;
    this.client = undefined;
    this.activeMailbox = undefined;
    this.mailboxCounts.clear();
    this.mailboxUidWatermarks.clear();
    this.mailboxUidValidity.clear();
    this.pendingEnrichment = undefined;

    if (client) {
      this.detachClientListeners(client);
      void client.logout().catch(() => undefined);
    }

    if (!this.started || this.reconnectTimer) {
      return;
    }

    if (this.outageStartedAt == null) {
      this.outageStartedAt = this.now();
    }

    const delay = this.computeBackoffDelay(this.reconnectAttempts + 1);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.started) {
        return;
      }

      void this.reconnect();
    }, delay);
  }

  /** Exponential backoff (base `reconnectDelayMs`, doubling per attempt,
   * capped at `maxReconnectDelayMs`) with full jitter -- the delay is drawn
   * uniformly from [0, cap] rather than added on top of it, so a fleet of
   * watchers reconnecting after a shared outage don't retry in lockstep. */
  private computeBackoffDelay(attempt: number): number {
    const exponential = this.reconnectDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.maxReconnectDelayMs);
    return Math.round(this.random() * capped);
  }

  private async reconnect(): Promise<void> {
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.emit('reconnecting');
    this.logger.debug(
      { accountId: this.account.id, attempt },
      `Reconnect attempt ${attempt} for account "${this.account.id}"`
    );

    try {
      await this.connectAndWatch();
      this.handleReconnectSuccess(attempt);
    } catch (error) {
      this.handleReconnectFailure(toError(error), attempt);
    }
  }

  /** Resets the failure/outage state and, if this reconnect actually ended
   * an outage, logs one `info` line naming how long it lasted and how many
   * attempts it took -- the "dropped, back after 3s, 2 attempts" record an
   * operator can read after the fact instead of either silence or a stack
   * trace. */
  private handleReconnectSuccess(attempt: number): void {
    const outageStartedAt = this.outageStartedAt;
    this.consecutiveFailures = 0;
    this.escalated = false;
    this.reconnectAttempts = 0;
    this.outageStartedAt = undefined;

    if (outageStartedAt == null) {
      return;
    }

    const durationMs = this.now().getTime() - outageStartedAt.getTime();
    this.logger.info(
      { accountId: this.account.id, attempts: attempt, durationMs },
      `Watcher for account "${this.account.id}" reconnected after ${durationMs}ms and ${attempt} attempt(s)`
    );
  }

  /** Logs each failed attempt at `debug`, and escalates to exactly one
   * `error` per outage once `reconnectFailureThreshold` consecutive
   * failures are reached -- `escalated` prevents re-logging `error` on
   * every attempt past that point. Always reschedules via
   * handleConnectionDrop, which applies the next backoff delay. */
  private handleReconnectFailure(error: Error, attempt: number): void {
    this.consecutiveFailures += 1;
    const code = errorCode(error);

    this.logger.debug(
      { accountId: this.account.id, attempt, code, err: error },
      `Reconnect attempt ${attempt} failed for account "${this.account.id}"`
    );

    if (!this.escalated && this.consecutiveFailures >= this.reconnectFailureThreshold) {
      this.escalated = true;
      this.logger.error(
        { accountId: this.account.id, attempts: this.consecutiveFailures, code, err: error },
        `Watcher for account "${this.account.id}" failed to reconnect after ${this.consecutiveFailures} consecutive attempts`
      );
    }

    this.handleConnectionDrop();
  }

  private attachClientListeners(client: WatcherClient): void {
    client.on('exists', this.handleExists);
    client.on('flags', this.handleFlags);
    client.on('expunge', this.handleExpunge);
    client.on('close', this.handleClose);
    client.on('error', this.handleError);
  }

  private detachClientListeners(client: WatcherClient): void {
    client.off('exists', this.handleExists);
    client.off('flags', this.handleFlags);
    client.off('expunge', this.handleExpunge);
    client.off('close', this.handleClose);
    client.off('error', this.handleError);
  }
}
