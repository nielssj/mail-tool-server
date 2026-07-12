# mail-tool-server

An HTTP API, [MCP](https://modelcontextprotocol.io/) server, and event bridge
over IMAP mailboxes. It exposes mailbox operations (list folders, list/get
messages, move, flag) as a REST API and as MCP tools for AI agents, and
watches configured mailboxes over a persistent IMAP `IDLE` connection, pushing
mail events (new mail, flag changes, removals) to configured webhook endpoints.

Built with Fastify + TypeScript + [`imapflow`](https://imapflow.com/), with
config/schema validation via `zod`, OpenAPI docs via `@fastify/swagger`, and
the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

## Requirements

- Node.js >= 20
- An IMAP account to connect to (any provider, or a local test server)

## Quick start

```bash
npm install
cp config.example.json config.json   # then edit config.json with real values
npm run dev                           # starts both interfaces
```

`npm run dev` (and `npm start`) bring up **both** the HTTP API
(`http://localhost:3000`) and the MCP server (`http://localhost:3001/mcp`) in
the same process by default — see [Environment variables](#environment-variables)
to run just one of them.

Verify the HTTP API is up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Open the interactive API docs at <http://localhost:3000/docs>. For the MCP
server, see [MCP Server](#mcp-server) below.

`config.json` is gitignored because it holds real credentials — only
`config.example.json` is committed.

## Configuration

The server loads a JSON config file describing one or more IMAP accounts,
plus optional object-storage settings. The path is resolved from the
`CONFIG_PATH` environment variable, falling back to `./config.json` in the
project root when unset. Invalid config fails fast at startup with a
descriptive error.

The file is a JSON **object** with an `accounts` array and an optional
`objectStorage` block:

| Field            | Type       | Description                                                                 |
| ---------------- | ---------- | --------------------------------------------------------------------------- |
| `id`             | string     | Unique account identifier, used in API paths (e.g. `personal`). Must be unique across accounts. |
| `host`           | string     | IMAP server hostname.                                                       |
| `port`           | number     | IMAP server port (e.g. `993` for IMAPS).                                     |
| `secure`         | boolean    | `true` for an implicit-TLS connection (IMAPS), `false` for plaintext/STARTTLS. |
| `auth.user`      | string     | Login username.                                                             |
| `auth.pass`      | string     | Login password (or app password).                                           |
| `watchMailboxes` | string[]   | Mailboxes to watch for events over IDLE (e.g. `["INBOX"]`). May be empty to disable watching. |
| `dispatchers`    | object[]   | Event dispatchers this account fans events out to. May be empty. See below. |
| `readOnly`       | boolean    | Optional, defaults to `false`. When `true`, the mutating operations (`move_message`/`set_flags` MCP tools, and the equivalent HTTP `POST .../move` and `POST .../flags` routes) are rejected with a clear error instead of executing. Read operations (list/get) are unaffected. |

### Dispatchers

Each entry in `dispatchers` is a discriminated union on `type`. The only type
implemented today is `webhook`:

| Field  | Type   | Description                                     |
| ------ | ------ | ----------------------------------------------- |
| `type` | string | Must be `"webhook"`.                             |
| `url`  | string | HTTPS/HTTP URL that receives event POSTs.        |

### Object storage

Optional — required only for the MCP `get_attachment` / `export_message`
tools, which stage large payloads (attachment bytes, full raw messages) here
and hand back a short-lived pre-signed download URL instead of inlining
bytes into a tool result. If omitted, those two tools return a tool error
explaining that object storage isn't configured; everything else works
without it. Points at any S3-compatible endpoint (real AWS S3, MinIO, R2,
etc.) via the AWS SDK v3.

| Field                        | Type    | Description                                                                 |
| ----------------------------- | ------- | ----------------------------------------------------------------------------- |
| `bucket`                      | string  | Bucket name to stage blobs into.                                              |
| `region`                      | string  | AWS region (optional — required for real AWS S3, not for most self-hosted endpoints). |
| `endpoint`                    | string  | Custom S3 API endpoint URL (e.g. a MinIO instance). Omit for real AWS S3.     |
| `forcePathStyle`               | boolean | `true` for path-style requests, required by most non-AWS S3-compatible endpoints (e.g. MinIO). |
| `credentials.accessKeyId`     | string  | Access key ID.                                                                |
| `credentials.secretAccessKey` | string  | Secret access key.                                                            |
| `urlTtlSeconds`               | number  | Pre-signed GET URL time-to-live, in seconds. Defaults to `900` (15 minutes).  |

Example (`config.example.json`):

```json
{
  "accounts": [
    {
      "id": "personal",
      "host": "imap.example.com",
      "port": 993,
      "secure": true,
      "auth": { "user": "you@example.com", "pass": "your-app-password" },
      "watchMailboxes": ["INBOX"],
      "dispatchers": [
        { "type": "webhook", "url": "https://your-app.example.com/hooks/mail" }
      ]
    }
  ],
  "objectStorage": {
    "bucket": "your-bucket-name",
    "region": "us-east-1",
    "credentials": {
      "accessKeyId": "your-access-key-id",
      "secretAccessKey": "your-secret-access-key"
    },
    "urlTtlSeconds": 900
  }
}
```

### Environment variables

| Variable        | Default        | Description                                                            |
| --------------- | -------------- | --------------------------------------------------------------------- |
| `CONFIG_PATH`   | `./config.json`| Path to the config file.                                              |
| `HOST`          | `0.0.0.0`      | Address both the HTTP API and MCP server bind to.                     |
| `PORT`          | `3000`         | Port the HTTP API listens on.                                        |
| `MCP_PORT`      | `3001`         | Port the MCP server listens on (`POST /mcp`).                        |
| `HTTP_ENABLED`  | `true`         | Set to `false` to disable the HTTP API and run only the MCP server.   |
| `MCP_ENABLED`   | `true`         | Set to `false` to disable the MCP server and run only the HTTP API.   |
| `NODE_ENV`      | `development`  | `development`/`test` produce human-readable logs; anything else emits structured JSON. |
| `LOG_LEVEL`     | `info`         | pino log level (`trace`…`fatal`, or `silent`).                        |

## Running

| Command                    | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `npm run dev`              | Start both interfaces with live TypeScript execution (`tsx`).      |
| `npm run build`            | Compile TypeScript to `dist/`.                                     |
| `npm start`                | Run the compiled server from `dist/` (run `build` first).          |
| `npm run docs:mcp`         | Regenerate the tool reference in `docs/mcp-tools.md` from the live tools. See below. |
| `npm run lint`             | Lint with ESLint.                                                 |
| `npm test`                 | Run the unit test suite (no Docker/network).                       |
| `npm run test:integration` | Run integration tests against a real IMAP server (requires Docker). See below. |
| `npm run test:all`         | Run unit tests, then integration tests.                            |

On shutdown (`SIGINT`/`SIGTERM`) the server closes all watcher IDLE
connections gracefully before exiting.

## HTTP API

Start the server and open the interactive Swagger UI at
<http://localhost:3000/docs> to browse every route, its request/response
schema, and try calls live. The raw OpenAPI 3 document is served at
<http://localhost:3000/openapi.json>. A liveness check is available at
`GET /health`.

## MCP Server

The same mailbox operations are also exposed as [MCP](https://modelcontextprotocol.io/)
tools for AI agents (Claude Desktop, Claude Code, or any MCP client) — a thin
adapter over the same `mailboxService` the HTTP API uses, so behavior never
drifts between the two. See **[docs/mcp-tools.md](docs/mcp-tools.md)** for the
full tool reference (every tool's parameters, output shape, and error codes).

**Transport:** Streamable HTTP, stateless, `POST /mcp` on `MCP_PORT` (default
`3001`) — a separate port from the HTTP API, in the same process. Started
automatically by `npm run dev`/`npm start` alongside the HTTP API; set
`HTTP_ENABLED=false` to run the MCP server on its own.

`get_attachment`/`export_message` require [Object storage](#object-storage)
configured. `move_message`/`set_flags` are disabled per-account by
[`readOnly`](#configuration).

### Connecting a client

**Claude Code:**

```bash
claude mcp add --transport http mail-tool http://localhost:3001/mcp
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mail-tool": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Client configuration syntax for remote/HTTP MCP servers has changed across
client versions — if either of the above doesn't work, check your client's
current MCP docs. As a client-independent way to verify the server itself
works, see the curl walkthrough in
**[docs/mcp-tools.md](docs/mcp-tools.md#trying-it-with-curl)**.

## Webhook events

For each account, every mailbox event detected by the watcher is POSTed as JSON
to each configured `webhook` dispatcher URL (with one retry on failure). All
events share this envelope:

```jsonc
{
  "event": "newMail",              // event type (see below)
  "accountId": "personal",         // the account id from config
  "mailbox": "INBOX",              // the watched mailbox
  "data": { /* per-event, see below */ },
  "timestamp": "2026-07-11T09:00:00.000Z"  // ISO-8601
}
```

| `event`        | Trigger                          | `data` fields                                            |
| -------------- | -------------------------------- | -------------------------------------------------------- |
| `newMail`      | Message count in the mailbox rose | `count` (new total), `previousCount` (prior total).      |
| `flagsChanged` | A message's flags were updated    | `uid`, `flags` (string[] of the message's current flags).|
| `mailRemoved`  | A message was expunged/removed    | `uid` (if available), `seq` (sequence number).           |

### Known limitation: "moved mail" detection

IMAP has no first-class "moved" notification. From the source mailbox's
perspective a move is indistinguishable from a deletion, so a move emits a
`mailRemoved` event on the source mailbox — it is **not** correlated to where
the message landed. True cross-folder move tracking is out of scope; treat
`mailRemoved` as "gone from this mailbox," not necessarily "deleted."

## Testing

Unit tests mock IMAP at the module boundary and run with no Docker or network:

```bash
npm test
```

Integration tests exercise the full stack against a **real** IMAP server
([GreenMail](https://greenmail-mail-test.github.io/greenmail/)) started in
Docker via [`testcontainers`](https://node.testcontainers.org/). They are
isolated from the unit suite and require a running Docker daemon:

```bash
npm run test:integration
```

## Project layout

```
src/
  utils/config/   JSON config loading + zod schema validation
  utils/logger.ts createLogger(config) factory (pino)
  imap/           clientFactory (short-lived connections) + watcher (IDLE)
  services/       mailboxService — core IMAP operations, shared by HTTP + MCP
  storage/        blobStore — stages large payloads into S3-compatible storage
  events/         domain event types, dispatcher framework + webhook dispatcher
  api/            Fastify routes + swagger plugin + error handler
  mcp/            MCP server: tool registration (tools/), errors.ts, format.ts,
                  server.ts (transport-agnostic), httpServer.ts (Streamable HTTP)
  app.ts          builds the Fastify instance (no listen)
  server.ts       entrypoint: config → watchers/services → HTTP API + MCP server
test/             unit tests (test/integration/ = container-backed suite)
docs/             docs/mcp-tools.md — full MCP tool reference
```
