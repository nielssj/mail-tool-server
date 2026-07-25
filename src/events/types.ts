export type NewMailEvent = {
  event: 'newMail';
  accountId: string;
  mailbox: string;
  data: {
    /** UID of this newly-arrived message. One event per message. */
    uid: number;
    /** Mailbox's total message count as observed when this message's
     * arrival was detected -- the same value on every event emitted from a
     * single burst of messages arriving at once, not a synthesized
     * per-message running total. */
    count: number;
  };
  timestamp: string;
};

export type FlagsChangedEvent = {
  event: 'flagsChanged';
  accountId: string;
  mailbox: string;
  data: {
    uid: number;
    flags: string[];
  };
  timestamp: string;
};

export type MailRemovedEvent = {
  event: 'mailRemoved';
  accountId: string;
  mailbox: string;
  data: {
    uid?: number;
    seq?: number;
  };
  timestamp: string;
};

export type DomainEvent = NewMailEvent | FlagsChangedEvent | MailRemovedEvent;
