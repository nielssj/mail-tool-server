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

`accountId` values come from `list_accounts`; mailbox paths (e.g. `"INBOX"`)
come from `list_mailboxes`. `get_attachment`/`export_message` require
[Object storage](../README.md#object-storage) configured. `move_message`/
`set_flags` are disabled per-account by [`readOnly`](../README.md#configuration).

The parameters, output shapes, and annotations below are generated directly
from the tools themselves (each tool's `description`, zod schemas, and
annotations) — see `scripts/mcpDocs.ts`. Run `npm run docs:mcp` after
changing a tool to regenerate; `npm test` fails if this section drifts from
the code.

<!-- BEGIN GENERATED TOOLS: run `npm run docs:mcp` to regenerate -->

### `list_accounts`

_Read-only._ List the configured mail accounts available to other tools, by id. Never includes credentials.

**Input:** none.

**Output:** `{ accounts: { id: string, host: string, watchMailboxes: string[] }[] }`

### `list_mailboxes`

_Read-only._ List the IMAP mailboxes (folders) for an account.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |

**Output:** `{ mailboxes: { path: string, name: string, delimiter: string, flags: string[], specialUse?: string }[] }`

### `list_messages`

_Read-only._ List messages in a mailbox as compact summaries (uid, subject, from, date, flags, snippet) — never full bodies. Use sinceUid to page incrementally.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path, from list_mailboxes (e.g. "INBOX"). |
| `limit` | number | no | Max messages to return. Default 50, hard max 200. |
| `sinceUid` | number | no | Only return messages with a uid greater than this, for incremental paging. |

**Output:** `{ messages: { uid: number, subject?: string, from?: string, date?: string, flags: string[], snippet: string }[] }`

### `get_message`

_Read-only._ Get a single message's envelope and body text. Body is capped at 8000 characters; when truncated, use export_message to retrieve the full content. Attachment metadata only, never bytes.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path, from list_mailboxes (e.g. "INBOX"). |
| `uid` | number | yes | Message UID, from list_messages. |

**Output:** `{ uid: number, subject?: string, from?: string, date?: string, flags: string[], body: string, truncated: boolean, attachments: { partId: string, filename?: string, mimeType: string, sizeBytes?: number }[], hint?: string }`

### `get_attachment`

_Read-only._ Fetch one message attachment's bytes (by uid + attachment part id) and stage them into object storage, returning a short-lived pre-signed download URL. Never returns bytes inline.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path, from list_mailboxes (e.g. "INBOX"). |
| `uid` | number | yes | Message UID, from list_messages. |
| `partId` | string | yes | Attachment part id, from get_message's attachments[].partId. |

**Output:** `{ url: string, filename: string, mimeType: string, sizeBytes: number, expiresAt: string, hint: string }`

### `export_message`

_Read-only._ Stage the full raw RFC822 message into object storage and return a short-lived pre-signed download URL — use this when get_message truncated the body. Never returns bytes inline.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path, from list_mailboxes (e.g. "INBOX"). |
| `uid` | number | yes | Message UID, from list_messages. |

**Output:** `{ url: string, filename: string, mimeType: string, sizeBytes: number, expiresAt: string, hint: string }`

### `move_message`

_Destructive._ Move a message to a different mailbox (folder).

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path, from list_mailboxes (e.g. "INBOX"). |
| `uid` | number | yes | Message UID, from list_messages. |
| `destination` | string | yes | Target mailbox path to move the message into. |

**Output:** `{ ok: boolean, destination: string }`

### `set_flags`

_Idempotent._ Add and/or remove IMAP flags (e.g. \Seen, \Flagged) on a message.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path, from list_mailboxes (e.g. "INBOX"). |
| `uid` | number | yes | Message UID, from list_messages. |
| `add` | string[] | no (default: `[]`) | IMAP flags to add, e.g. ["\Flagged"]. |
| `remove` | string[] | no (default: `[]`) | IMAP flags to remove, e.g. ["\Seen"]. |

**Output:** `{ ok: boolean }`

### `create_draft`

Compose a draft email (to/cc/bcc, subject, text and/or html body, optional attachments) and save it into a mailbox — typically the account's Drafts folder, found via list_mailboxes' specialUse. Does not send the message.

**Input:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | yes | Account id, from list_accounts. |
| `mailbox` | string | yes | Mailbox path to save the draft into, e.g. "Drafts" (from list_mailboxes). |
| `to` | string[] | no | Recipient addresses, e.g. "Jane Doe <jane@example.com>". |
| `cc` | string[] | no |  |
| `bcc` | string[] | no |  |
| `subject` | string | no |  |
| `text` | string | no | Plain-text body. |
| `html` | string | no | HTML body. |
| `attachments` | { filename: string, mimeType: string, contentBase64: string }[] | no |  |

**Output:** `{ mailbox: string, uid?: number, uidValidity?: string }`

<!-- END GENERATED TOOLS -->

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
