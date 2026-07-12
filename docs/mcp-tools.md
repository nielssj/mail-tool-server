# MCP Server Reference

The MCP server exposes the same mailbox operations as the [HTTP API](../README.md#http-api)
through the [Model Context Protocol](https://modelcontextprotocol.io/), shaped
for efficient, low-token agentic use. It's a thin adapter over the same
`mailboxService` the HTTP API uses — no separate IMAP logic, no drift between
the two.

See the [README](../README.md#mcp-server) for how to run it and connect a
client. This doc is the tool reference.

## Transport

**Streamable HTTP**, stateless. `POST /mcp` on its own port (`MCP_PORT`,
default `3001`) — separate from the HTTP API's port, in the same process.
Every request gets a fresh server instance, so there's no session to
resume and no `Mcp-Session-Id` header to track; `GET`/`DELETE /mcp` (used
for SSE streaming and explicit session termination in stateful MCP servers)
return `405 Method Not Allowed`.

## Error shape

Every tool call that fails returns a stable, typed error instead of a raw
exception or stack trace:

```jsonc
{
  "content": [{ "type": "text", "text": "Unknown account id: \"nope\"" }],
  "structuredContent": {
    "error": { "code": "NOT_FOUND", "message": "Unknown account id: \"nope\"" }
  },
  "isError": true
}
```

| Code                          | Meaning                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| `NOT_FOUND`                    | Unknown `accountId`/`mailbox`, or no message/attachment at that uid/part id. |
| `IMAP_CONNECTION_ERROR`        | Couldn't connect to the account's IMAP server.                       |
| `READ_ONLY_ACCOUNT`            | The account has `readOnly: true` in config.json; `move_message`/`set_flags` are disabled for it. |
| `OBJECT_STORAGE_NOT_CONFIGURED` | `get_attachment`/`export_message` called with no `objectStorage` block in config.json. |
| `INTERNAL_ERROR`               | Anything unexpected — message is always the generic `"Internal server error"`, never the original error or a stack trace. |

## Tools

`accountId` and `mailbox` are required on every tool below unless noted.
`accountId` values come from `list_accounts`; mailbox paths (e.g. `"INBOX"`)
come from `list_mailboxes`.

### `list_accounts`

Read-only. Lists configured accounts. **Never** returns credentials.

- **Input:** none.
- **Output:** `{ accounts: [{ id, host, watchMailboxes }] }`

### `list_mailboxes`

Read-only. Lists the IMAP folders for an account.

- **Input:** `accountId`.
- **Output:** `{ mailboxes: [{ path, name, delimiter, flags, specialUse? }] }`

### `list_messages`

Read-only. Compact, paginated summaries — **never full bodies**. This is the
cheap way to triage a mailbox before drilling into a specific message with
`get_message`.

- **Input:** `accountId`, `mailbox`, `limit` (integer, 1–200, default 50),
  `sinceUid` (integer, optional — page forward from this uid).
- **Output:** `{ messages: [{ uid, subject?, from?, date?, flags, snippet }] }`.
  `snippet` is a best-effort preview (raw bytes of the first MIME part,
  undecoded) — for the real body, call `get_message`.

### `get_message`

Read-only. Envelope + body text for one message.

- **Input:** `accountId`, `mailbox`, `uid`.
- **Output:** `{ uid, subject?, from?, date?, flags, body, truncated, attachments, hint? }`.
  `body` is capped at **8000 characters**; when the real body is longer,
  `truncated` is `true` and `hint` names `export_message` for the full
  content. `attachments` is metadata only (`partId`, `filename?`, `mimeType`,
  `sizeBytes?`) — never bytes.

### `get_attachment`

Read-only. Stages one attachment's bytes into object storage and returns a
short-lived download URL — never inlines bytes into the tool result.
Requires `objectStorage` configured (see the README's
[Object storage](../README.md#object-storage) section).

- **Input:** `accountId`, `mailbox`, `uid`, `partId` (from `get_message`'s
  `attachments[].partId`).
- **Output:** `{ url, filename, mimeType, sizeBytes, expiresAt, hint }`. Fetch
  `url` directly (e.g. a plain `GET`) to download the bytes; it expires at
  `expiresAt`.

### `export_message`

Read-only. Stages the full raw RFC822 message into object storage — use this
when `get_message` reported `truncated: true`. Same requirement and output
shape as `get_attachment`.

- **Input:** `accountId`, `mailbox`, `uid`.
- **Output:** `{ url, filename, mimeType, sizeBytes, expiresAt, hint }`.

### `move_message`

**Destructive.** Moves a message to a different mailbox. Disabled
(`READ_ONLY_ACCOUNT`) if the account has `readOnly: true`.

- **Input:** `accountId`, `mailbox`, `uid`, `destination` (target mailbox path).
- **Output:** `{ ok: true, destination }`.

### `set_flags`

**Idempotent.** Adds and/or removes IMAP flags (e.g. `\Seen`, `\Flagged`) on
a message. Disabled (`READ_ONLY_ACCOUNT`) if the account has `readOnly: true`.

- **Input:** `accountId`, `mailbox`, `uid`, `add` (string array, default
  `[]`), `remove` (string array, default `[]`).
- **Output:** `{ ok: true }`.

## Trying it with curl

No client needed — every tool call is a single `POST` to `/mcp`. This example
lists the configured accounts (works even with zero accounts configured):

```bash
curl -s http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "list_accounts", "arguments": {} }
  }'
```

With at least one account configured, the response looks like:

```
event: message
data: {"result":{"content":[{"type":"text","text":"Found 1 account(s)."}],"structuredContent":{"accounts":[{"id":"personal","host":"imap.example.com","watchMailboxes":["INBOX"]}]}},"jsonrpc":"2.0","id":1}
```

To discover the full tool list (names, input/output JSON Schema, annotations)
straight from the running server:

```bash
curl -s http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

A real MCP client performs a protocol handshake (`initialize`, then a
`notifications/initialized` notification) before its first `tools/list` or
`tools/call` — see the [MCP spec](https://modelcontextprotocol.io/specification)
if you're writing a client from scratch. The stateless transport here doesn't
track handshake state per request, so the curl examples above work standalone
without it.
