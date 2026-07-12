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

const formatEnvelope = (message: FetchMessageObject): EnvelopeSummary => ({
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
