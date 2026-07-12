import { describe, it, expect } from 'vitest';
import { toToolError, withToolErrors, NotFoundError } from '../src/mcp/errors.js';
import { ImapConnectionError } from '../src/imap/clientFactory.js';
import { ReadOnlyAccountError } from '../src/services/mailboxService.js';
import { ObjectStorageNotConfiguredError } from '../src/storage/blobStore.js';

describe('toToolError', () => {
  it('maps NotFoundError to NOT_FOUND', () => {
    const result = toToolError(new NotFoundError('Message not found: uid 1 in mailbox "INBOX"'));
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Message not found: uid 1 in mailbox "INBOX"' }],
      structuredContent: {
        error: { code: 'NOT_FOUND', message: 'Message not found: uid 1 in mailbox "INBOX"' }
      }
    });
  });

  it('maps a plain Error matching isResourceNotFoundError to NOT_FOUND', () => {
    const result = toToolError(new Error('Unknown account id: "missing"'));
    expect(result.structuredContent).toEqual({
      error: { code: 'NOT_FOUND', message: 'Unknown account id: "missing"' }
    });
  });

  it('maps ImapConnectionError to IMAP_CONNECTION_ERROR', () => {
    const result = toToolError(
      new ImapConnectionError('Failed to connect to IMAP account "acc-1"')
    );
    expect(result.structuredContent).toEqual({
      error: {
        code: 'IMAP_CONNECTION_ERROR',
        message: 'Failed to connect to IMAP account "acc-1"'
      }
    });
  });

  it('maps ReadOnlyAccountError to READ_ONLY_ACCOUNT', () => {
    const result = toToolError(new ReadOnlyAccountError('acc-1', 'move_message'));
    expect(result.structuredContent).toEqual({
      error: {
        code: 'READ_ONLY_ACCOUNT',
        message: 'Account "acc-1" is read-only; move_message is disabled.'
      }
    });
  });

  it('maps ObjectStorageNotConfiguredError to OBJECT_STORAGE_NOT_CONFIGURED', () => {
    const result = toToolError(new ObjectStorageNotConfiguredError());
    expect(result.structuredContent.error.code).toBe('OBJECT_STORAGE_NOT_CONFIGURED');
  });

  it('reduces an unrecognized error to a generic INTERNAL_ERROR without leaking its message', () => {
    const result = toToolError(new Error('ECONNRESET: socket hang up at /home/app/src/x.ts:42'));
    expect(result.structuredContent).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Internal server error' }]);
    expect(JSON.stringify(result)).not.toContain('ECONNRESET');
    expect(JSON.stringify(result)).not.toContain('x.ts:42');
  });

  it('reduces a thrown non-Error value to the same generic INTERNAL_ERROR', () => {
    const result = toToolError('a raw string was thrown, not an Error');
    expect(result.structuredContent).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
    });
  });

  it('never includes a stack trace in the response', () => {
    const error = new Error('boom');
    const result = toToolError(error);
    expect(JSON.stringify(result)).not.toContain(error.stack?.split('\n')[1] ?? '__unused__');
  });
});

describe('withToolErrors', () => {
  it('passes through a successful result unchanged', async () => {
    const wrapped = withToolErrors(async (n: number) => ({ doubled: n * 2 }));
    const result = await wrapped(21);
    expect(result).toEqual({ doubled: 42 });
  });

  it('catches a thrown error and returns a mapped isError result instead of rejecting', async () => {
    const wrapped = withToolErrors(async () => {
      throw new NotFoundError('not found');
    });
    const result = await wrapped();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND', message: 'not found' } }
    });
  });
});
