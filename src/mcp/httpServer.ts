import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import type { MailboxService } from '../services/mailboxService.js';
import type { AccountConfig } from '../utils/config/schema.js';
import type { BlobStore } from '../storage/blobStore.js';

export type CreateMcpHttpServerOptions = {
  mailboxService: MailboxService;
  accounts: AccountConfig[];
  blobStore?: BlobStore;
};

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error as Error);
      }
    });
    req.on('error', reject);
  });

const sendJsonRpcError = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
};

const handleMcpRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateMcpHttpServerOptions
): Promise<void> => {
  // Stateless: a Server instance can only be connected to one transport at a
  // time, so each request gets its own McpServer + transport pair rather
  // than sharing one across concurrent callers.
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    const body = await readJsonBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, (error as Error).message);
    }
  }
};

/**
 * Streamable HTTP MCP server (POST /mcp), run on its own port separate from
 * the HTTP API's Fastify instance. Stateless mode — GET/DELETE (SSE
 * streaming, explicit session termination) aren't supported since there is
 * no persisted session to address.
 */
export const createMcpHttpServer = (options: CreateMcpHttpServerOptions): Server =>
  createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'POST') {
      void handleMcpRequest(req, res, options);
      return;
    }

    sendJsonRpcError(res, 405, 'Method not allowed.');
  });
