# mail-tool-server

An HTTP API and event bridge over IMAP mailboxes. It exposes mailbox
operations (list folders, list/get messages, move, flag) as a REST API, and
watches configured mailboxes over a persistent IMAP `IDLE` connection, pushing
mail events (new mail, flag changes, removals) to configured webhook endpoints.

Built with Fastify + TypeScript + [`imapflow`](https://imapflow.com/), with
config/schema validation via `zod` and OpenAPI docs via `@fastify/swagger`.

## Requirements

- Node.js >= 20
- An IMAP account to connect to (any provider, or a local test server)

## Quick start

```bash
npm install
cp config.example.json config.json   # then edit config.json with real values
npm run dev                           # starts the server on http://localhost:3000
```

Verify it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Open the interactive API docs at <http://localhost:3000/docs>.

`config.json` is gitignored because it holds real credentials — only
`config.example.json` is committed.

## Configuration

The server loads a JSON config file describing one or more IMAP accounts. The
path is resolved from the `CONFIG_PATH` environment variable, falling back to
`./config.json` in the project root when unset. Invalid config fails fast at
startup with a descriptive error.

The file is a JSON **array** of account objects:

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

### Dispatchers

Each entry in `dispatchers` is a discriminated union on `type`. The only type
implemented today is `webhook`:

| Field  | Type   | Description                                     |
| ------ | ------ | ----------------------------------------------- |
| `type` | string | Must be `"webhook"`.                             |
| `url`  | string | HTTPS/HTTP URL that receives event POSTs.        |

Example (`config.example.json`):

```json
[
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
]
```

### Environment variables

| Variable      | Default        | Description                                                            |
| ------------- | -------------- | --------------------------------------------------------------------- |
| `CONFIG_PATH` | `./config.json`| Path to the config file.                                              |
| `HOST`        | `0.0.0.0`      | Address the HTTP server binds to.                                     |
| `PORT`        | `3000`         | Port the HTTP server listens on.                                     |
| `NODE_ENV`    | `development`  | `development`/`test` produce human-readable logs; anything else emits structured JSON. |
| `LOG_LEVEL`   | `info`         | pino log level (`trace`…`fatal`, or `silent`).                        |

## Running

| Command                    | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `npm run dev`              | Start the server with live TypeScript execution (`tsx`).           |
| `npm run build`            | Compile TypeScript to `dist/`.                                     |
| `npm start`                | Run the compiled server from `dist/` (run `build` first).          |
| `npm run lint`             | Lint with ESLint.                                                 |
| `npm test`                 | Run the unit test suite (no Docker/network).                       |
| `npm run test:integration` | Run integration tests against a real IMAP server (requires Docker). See below. |
| `npm run test:all`         | Run unit tests, then integration tests.                            |

On shutdown (`SIGINT`/`SIGTERM`) the server closes all watcher IDLE
connections gracefully before exiting.

## HTTP API

All operation routes are scoped to an account by its configured `id`. Path
segments are URL-encoded, so mailbox names containing `/` should be encoded
(e.g. `Archive%2F2024`).

| Method & path                                                        | Description                                    |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| `GET /health`                                                        | Liveness check → `{ "status": "ok" }`.         |
| `GET /docs`                                                          | Swagger UI.                                    |
| `GET /openapi.json`                                                  | OpenAPI 3 document for all routes.             |
| `GET /accounts/:accountId/mailboxes`                                 | List mailboxes/folders for the account.        |
| `GET /accounts/:accountId/mailboxes/:mailbox/messages`              | List messages in a mailbox. Query: `limit` (max returned, most recent), `sinceUid` (only UIDs ≥ this). |
| `GET /accounts/:accountId/mailboxes/:mailbox/messages/:uid`        | Fetch a single message by UID.                 |
| `POST /accounts/:accountId/mailboxes/:mailbox/messages/:uid/move`  | Move a message. Body: `{ "destination": "Archive" }` → `{ "ok": true }`. |
| `POST /accounts/:accountId/mailboxes/:mailbox/messages/:uid/flags` | Add/remove flags. Body: `{ "add": ["\\Seen"], "remove": ["\\Flagged"] }` → `{ "ok": true }`. |

### Error responses

Errors use a consistent shape:

```json
{ "error": { "message": "Message not found", "code": "NOT_FOUND" } }
```

| HTTP status | `code`                   | When                                             |
| ----------- | ------------------------ | ------------------------------------------------ |
| 400         | `VALIDATION_ERROR`       | Request failed schema validation.                |
| 404         | `NOT_FOUND`              | Unknown account/mailbox, or message not found.   |
| 503         | `IMAP_CONNECTION_ERROR`  | Could not connect to the upstream IMAP server.   |
| 500         | `INTERNAL_ERROR`         | Unexpected server error.                          |

### Example

```bash
# List mailboxes for the "personal" account
curl http://localhost:3000/accounts/personal/mailboxes

# Flag message UID 42 in INBOX as seen
curl -X POST http://localhost:3000/accounts/personal/mailboxes/INBOX/messages/42/flags \
  -H 'Content-Type: application/json' \
  -d '{"add":["\\Seen"]}'
```

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
  services/       mailboxService — core IMAP operations
  events/         domain event types, dispatcher framework + webhook dispatcher
  api/            Fastify routes + swagger plugin + error handler
  app.ts          builds the Fastify instance (no listen)
  server.ts       entrypoint: config → watchers → dispatchers → listen
test/             unit tests (test/integration/ = container-backed suite)
```
