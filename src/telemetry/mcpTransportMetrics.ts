import type { Server } from 'node:http';
import * as telemetry from './instruments.js';

/**
 * Attaches an additional 'request' listener to the MCP HTTP server to
 * record mailtool.mcp.request.duration for every POST /mcp call, without
 * mcp/httpServer.ts needing any telemetry awareness — Node's http.Server
 * already supports multiple independent 'request' listeners, so this sits
 * alongside the server's own handler rather than replacing it. Outcome is
 * plain HTTP status semantics (transport-level), not MCP/JSON-RPC-aware —
 * that granularity is what mailtool.mcp.tool.duration is for.
 */
export const observeMcpTransportMetrics = (server: Server): void => {
  server.on('request', (req, res) => {
    const start = performance.now();
    res.on('finish', () => {
      telemetry.mcpRequestDuration.record((performance.now() - start) / 1000, {
        outcome: res.statusCode < 400 ? 'ok' : 'error'
      });
    });
  });
};
