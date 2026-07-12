import { ImapConnectionError } from '../imap/clientFactory.js';
import { ReadOnlyAccountError } from '../services/mailboxService.js';
import { ObjectStorageNotConfiguredError } from '../storage/blobStore.js';
import { NotFoundError, isResourceNotFoundError } from '../api/routes/shared.js';

export { NotFoundError };

export type ToolErrorResult = {
  content: [{ type: 'text'; text: string }];
  structuredContent: { error: { code: string; message: string } };
  isError: true;
};

/**
 * Maps a caught error to a stable { code, message } pair. Anything not
 * recognized here is treated as unexpected and reduced to a generic
 * message — the original error (and any stack trace) never reaches the
 * client, mirroring api/errorHandler.ts's 500 case.
 */
const mapError = (error: unknown): { code: string; message: string } => {
  if (error instanceof ReadOnlyAccountError) {
    return { code: 'READ_ONLY_ACCOUNT', message: error.message };
  }
  if (error instanceof ObjectStorageNotConfiguredError) {
    return { code: 'OBJECT_STORAGE_NOT_CONFIGURED', message: error.message };
  }
  if (error instanceof ImapConnectionError) {
    return { code: 'IMAP_CONNECTION_ERROR', message: error.message };
  }
  if (error instanceof NotFoundError || isResourceNotFoundError(error)) {
    return { code: 'NOT_FOUND', message: (error as Error).message };
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' };
};

export const toToolError = (error: unknown): ToolErrorResult => {
  const { code, message } = mapError(error);
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: { code, message } },
    isError: true
  };
};

/**
 * Wraps a tool handler so any thrown error becomes a stable, typed
 * isError:true CallToolResult instead of propagating. The SDK's own
 * registerTool already catches thrown errors and turns them into a
 * text-only isError result, but skips output-schema validation only in
 * that fallback path (McpServer.validateToolOutput returns early when
 * result.isError is true) — so returning our own isError result here,
 * rather than throwing, is what lets error responses carry
 * structuredContent without failing validation against the tool's success
 * outputSchema.
 */
export const withToolErrors = <Args extends unknown[], R>(
  handler: (...args: Args) => Promise<R>
) => {
  return async (...args: Args): Promise<R | ToolErrorResult> => {
    try {
      return await handler(...args);
    } catch (error) {
      return toToolError(error);
    }
  };
};
