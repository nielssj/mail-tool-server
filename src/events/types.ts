export type NewMailEvent = {
  event: 'newMail';
  accountId: string;
  mailbox: string;
  data: {
    count: number;
    previousCount: number;
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
