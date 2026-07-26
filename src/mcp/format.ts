import type { FetchMessageObject } from 'imapflow';
import type { MessageAttachment, MessageDetail } from '../services/mailboxService.js';

export const DEFAULT_BODY_CAP_CHARS = 8000;
const SNIPPET_MAX_CHARS = 200;

export type EnvelopeSummary = {
  uid: number;
  subject?: string;
  from?: string;
  date?: string;
  flags: string[];
};

export type MessageSummary = EnvelopeSummary & { snippet: string };

export type MessageBody = EnvelopeSummary & {
  body: string;
  truncated: boolean;
  attachments: MessageAttachment[];
};

const formatFrom = (message: FetchMessageObject): string | undefined => {
  const from = message.envelope?.from?.[0];
  if (!from) {
    return undefined;
  }
  return from.name ? `${from.name} <${from.address}>` : from.address;
};

const cleanSnippet = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_MAX_CHARS);

export const formatEnvelope = (message: FetchMessageObject): EnvelopeSummary => ({
  uid: message.uid,
  subject: message.envelope?.subject,
  from: formatFrom(message),
  date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : undefined,
  flags: message.flags ? Array.from(message.flags) : []
});

/**
 * Compact, agent-friendly projection for `list_messages` — never a full
 * body, just enough to triage. `snippet` is a best-effort preview from the
 * raw bytes of MIME part "1" (see mailboxService's LIST_FETCH_QUERY):
 * undecoded, so it may occasionally show quoted-printable/base64 artifacts.
 * `get_message` is the source of truth for the real body.
 */
export const formatMessageSummary = (
  message: FetchMessageObject & { bodyParts?: Map<string, Buffer> }
): MessageSummary => ({
  ...formatEnvelope(message),
  snippet: cleanSnippet(message.bodyParts?.get('1')?.toString('utf8') ?? '')
});

/**
 * Bounds `get_message`'s body to `capChars` (default 8000), signalling
 * truncation so the caller can point the agent at `export_message`.
 */
export const formatMessageBody = (
  message: MessageDetail,
  capChars: number = DEFAULT_BODY_CAP_CHARS
): MessageBody => {
  const truncated = message.body.length > capChars;
  return {
    ...formatEnvelope(message),
    body: truncated ? message.body.slice(0, capChars) : message.body,
    truncated,
    attachments: message.attachments
  };
};

export type MessageDetails = EnvelopeSummary & {
  body: string;
  attachments: MessageAttachment[];
};

/**
 * Full projection of a MessageDetail for the plain HTTP API. Unlike
 * formatMessageBody (capped for MCP/agent-context use), this exposes the
 * complete decoded body -- an HTTP caller isn't paying for tokens, and
 * export_message-style truncation has no equivalent here.
 *
 * Explicitly picks only uid/subject/from/date/flags/body/attachments.
 * Every other field ImapFlow's FetchMessageObject may carry on a
 * MessageDetail is deliberately left off the response:
 *  - source: the raw message buffer -- large, redundant with the
 *    dedicated raw-export path (get_raw_source/getRawSource), and not
 *    JSON-friendly (serializes as a numbered-object byte array).
 *  - bodyStructure: ImapFlow's internal MIME tree, used to derive `body`/
 *    `attachments` above -- an implementation detail, not a stable
 *    contract worth exposing.
 *  - seq: the IMAP sequence number, connection/session-scoped and not a
 *    stable identifier -- uid already is.
 *  - internalDate: server-received timestamp, distinct from `date` (the
 *    envelope's Date: header) -- not requested, and easy to confuse with
 *    `date` if both were exposed.
 *  - size: byte size of the raw message, not requested.
 *  - modseq: a bigint (CONDSTORE-only) -- would throw serializing to JSON
 *    if ever populated.
 *  - emailId / threadId / labels: Gmail/X-GM-EXT-1-extension-only fields,
 *    not populated by most servers and not part of this API's contract.
 *  - flagColor: cosmetic, derived from flags, ImapFlow-specific.
 *  - bodyParts / headers: raw Buffers used internally to build `body`,
 *    same non-JSON-friendly problem as `source`.
 *  - id: an account-scoped opaque token, not documented as broadly
 *    supported across providers.
 */
export const formatMessageDetails = (message: MessageDetail): MessageDetails => ({
  ...formatEnvelope(message),
  body: message.body,
  attachments: message.attachments
});
