import { describe, it, expect } from 'vitest';
import { formatMessageDetails } from '../src/mcp/format.js';
import type { MessageDetail } from '../src/services/mailboxService.js';

const makeMessageDetail = (): MessageDetail => ({
  seq: 1,
  uid: 42,
  flags: new Set(['\\Seen', '\\Flagged']),
  envelope: {
    subject: 'Hello',
    from: [{ name: 'Jane Doe', address: 'jane@example.com' }],
    date: new Date('2024-01-01T00:00:00.000Z')
  },
  internalDate: new Date('2024-01-02T00:00:00.000Z'),
  size: 100,
  source: Buffer.from('raw message bytes'),
  bodyStructure: { part: '1', type: 'text/plain', size: 12 },
  modseq: BigInt(1),
  emailId: 'email-id-1',
  threadId: 'thread-id-1',
  labels: new Set(['\\Important']),
  flagColor: 'yellow',
  bodyParts: new Map([['1', Buffer.from('Body bytes')]]),
  headers: Buffer.from('Subject: x\r\n'),
  id: 'account-scoped-id',
  body: 'Hello world',
  attachments: [{ partId: '2', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 3 }]
});

describe('formatMessageDetails', () => {
  it('picks only uid/subject/from/date/flags/body/attachments', () => {
    const result = formatMessageDetails(makeMessageDetail());

    expect(result).toEqual({
      uid: 42,
      subject: 'Hello',
      from: 'Jane Doe <jane@example.com>',
      date: '2024-01-01T00:00:00.000Z',
      flags: ['\\Seen', '\\Flagged'],
      body: 'Hello world',
      attachments: [{ partId: '2', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 3 }]
    });
  });

  it('excludes every documented ImapFlow-native field', () => {
    const result = formatMessageDetails(makeMessageDetail()) as Record<string, unknown>;

    for (const leaked of [
      'source',
      'bodyStructure',
      'seq',
      'modseq',
      'emailId',
      'threadId',
      'labels',
      'flagColor',
      'bodyParts',
      'headers',
      'id',
      'internalDate',
      'size'
    ]) {
      expect(result).not.toHaveProperty(leaked);
    }
  });

  it('has no full body length cap, unlike formatMessageBody', () => {
    const longBody = 'x'.repeat(20_000);
    const result = formatMessageDetails({ ...makeMessageDetail(), body: longBody });

    expect(result.body).toHaveLength(20_000);
  });

  it('handles a message with no envelope/flags gracefully', () => {
    const result = formatMessageDetails({
      seq: 1,
      uid: 7,
      body: '',
      attachments: []
    });

    expect(result).toEqual({
      uid: 7,
      subject: undefined,
      from: undefined,
      date: undefined,
      flags: [],
      body: '',
      attachments: []
    });
  });
});
