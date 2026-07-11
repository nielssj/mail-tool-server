## MCP Tool Interface — High-Level Plan

**Goal:** Expose the existing `mailboxService` operations to AI agents through a
[Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server, so an
agent (Claude Desktop, Claude Code, or any MCP client) can list, read, move,
and flag mail across the configured accounts — the same capabilities as the
HTTP API, but shaped for efficient, low-token agentic use.

**Stack additions:** `@modelcontextprotocol/sdk` (official TypeScript SDK).
Everything else reuses what already exists: `mailboxService`, the zod config
schema/loader, `createLogger`, and the resource-not-found detection in
`api/routes/shared.ts`.

### Guiding principle: reuse, don't re-implement

The MCP layer is a **thin adapter** over `mailboxService`. It performs no IMAP
work of its own — it validates inputs, calls the same service methods the HTTP
routes call, and formats results for an LLM. IMAP behavior therefore stays in
one place, and the HTTP API and MCP interface can never drift.

```
src/
  services/mailboxService.ts   (unchanged core — reused as-is)
  mcp/
    server.ts        createMcpServer({ mailboxService, accounts, blobStore }) -> McpServer
                     (transport-agnostic; registers all tools)
    tools/           one file per tool group (accounts, messages, delivery, mutations)
    format.ts        service objects -> compact, agent-friendly payloads
    errors.ts        map service errors -> MCP tool errors (isError + message)
  storage/
    blobStore.ts     stage a blob into S3-style object storage under a random
                     key, return a short-lived pre-signed GET URL (+ metadata)
  bootstrap.ts       (new) buildServices(config) -> { mailboxService, watchers, blobStore }
                     shared by server.ts and mcp-server.ts (removes duplication)
  mcp-server.ts      stdio entrypoint: config -> services -> createMcpServer
                     -> StdioServerTransport
  server.ts          (existing HTTP entrypoint, refactored to use bootstrap.ts)
```

### Tools to expose

MCP **tools** (callable actions), not resources — tools take parameters and map
cleanly onto the service methods. Names are snake_case verbs, which read well in
tool-call traces.

| Tool             | Maps to                          | Notes                                                                 |
| ---------------- | -------------------------------- | --------------------------------------------------------------------- |
| `list_accounts`  | (config)                         | **New.** Agents need to discover valid `accountId`s; the HTTP API has no such endpoint. Returns `id`, `host`, `watchMailboxes` — **never** credentials. |
| `list_mailboxes` | `listMailboxes(accountId)`       | Folder list.                                                          |
| `list_messages`  | `listMessages(accountId, mailbox, { limit, sinceUid })` | Returns **compact summaries** (see below), paginated. |
| `get_message`    | `getMessage(accountId, mailbox, uid)` | Envelope + body text **up to a strict cap**; truncates with a hint to `export_message`. Attachment metadata only, never bytes (see decision below). |
| `get_attachment` | (new content fetch)              | Returns a short-lived **pre-signed URL** to download one attachment's bytes (by `uid` + attachment part id) + `{ filename, mimeType, sizeBytes, expiresAt }`. |
| `export_message` | (new content fetch)              | Returns a short-lived **pre-signed URL** to download the **full** message (raw RFC822 / full body) when `get_message` truncated + the same metadata shape. |
| `move_message`   | `moveMessage(accountId, mailbox, uid, destination)` | Mutating; annotated destructive. |
| `set_flags`      | `setFlags(accountId, mailbox, uid, add, remove)` | Mutating; idempotent.            |

### Key design decisions (for agent efficiency)

- **Compact message summaries, full body only on demand.** `list_messages`
  returns just what an agent needs to triage — `uid`, `subject`, `from`,
  `date`, `flags`, and a short snippet — never full bodies. This is the single
  biggest token saver: an agent scans a lightweight list, then calls
  `get_message` for the one it cares about. `format.ts` owns this projection.

- **Message retrieval must fetch bodies — a gap to close first.** Today both
  `listMessages` and `getMessage` share a `FETCH_QUERY` that fetches only
  envelope metadata (`uid, flags, envelope, internalDate, size`) — **no body**.
  Message retrieval is extended at the service level (so the HTTP API benefits
  too and IMAP stays in one place) to fetch the text body (prefer `text/plain`;
  downconvert `text/html` to text), the raw source, and attachment **metadata**
  (filename, mime type, size, part id) — never attachment bytes inline.

- **`get_message` returns a bounded body; overflow goes out-of-band.**
  `get_message` returns the text body only **up to a strict character cap** (e.g.
  ~8–16 KB, configurable). When the body exceeds the cap, the response is
  truncated at the limit with an explicit marker and a hint that names
  `export_message` as the way to retrieve the full content. This guarantees a
  bounded, predictable context cost for the common read while never leaving the
  agent stranded without the rest. Attachment metadata is always included; bytes
  never are.

- **Large payloads are delivered as pre-signed URLs, never inlined.**
  `export_message` (full raw message / full body) and `get_attachment`
  (a single attachment's bytes) stage the content into S3-style object storage
  under a random key and return a short-lived, self-authenticating **pre-signed
  GET URL** plus metadata (`filename`, `mimeType`, `sizeBytes`, `expiresAt`) and
  a download hint. The caller fetches the bytes directly, so heavy content never
  enters the tool result. Filenames are **server-sanitized** (never taken raw
  from attacker-controlled email headers), and URLs carry a short TTL. Both tools
  share the `storage/blobStore.ts` seam.

- **Structured output, not just text.** Each tool declares an `outputSchema`
  (zod) and returns `structuredContent`, so the agent receives typed JSON rather
  than parsing prose. A concise human-readable `text` block is included
  alongside for clients that only render text.

- **Tool annotations advertise safety.** Read tools (`list_*`, `get_message`,
  `get_attachment`, `export_message`) are marked `readOnlyHint`; `set_flags`
  `idempotentHint`; `move_message` `destructiveHint`. This lets agents/clients
  reason about which calls are safe to make freely vs. worth confirming.

- **Bounded results.** `list_messages` enforces a sensible default `limit`
  (e.g. 50) and a hard maximum, with `sinceUid` for incremental paging — an
  agent can never accidentally pull a 100k-message mailbox into context.

- **Errors become tool errors, reusing existing mapping.** `errors.ts` reuses
  `isResourceNotFoundError` and the `ImapConnectionError` type to translate
  service failures into MCP tool results with `isError: true` and a clear,
  actionable message (`Unknown account "x"`, `Could not connect to IMAP …`),
  rather than leaking stack traces. Same taxonomy as the HTTP error handler.

- **Transport: stdio first, Streamable HTTP later.** `createMcpServer` is
  transport-agnostic. v1 ships a **stdio** entrypoint (`mcp-server.ts`) — the
  common case for local agents and trivial to configure in Claude Desktop /
  Claude Code. A later task can mount the SDK's **Streamable HTTP** transport on
  the existing Fastify app for remote/multi-client use, behind bearer-token auth.

- **Trust boundary is explicit.** The MCP server hands an agent full read/write
  access to real mailboxes using the credentials in `config.json`. v1 assumes a
  trusted local agent over stdio. Any networked (HTTP) transport is gated on
  authentication and is called out as its own task, not bundled into v1.

- **Testability mirrors the repo.** Tools are unit-tested against a mocked
  `mailboxService` (as the HTTP routes are), and an in-process integration test
  drives a real `McpServer` through the SDK's in-memory transport
  (`client.callTool(...)`) — no sockets, no Docker in the unit suite.

---

## Task Breakdown

Each task is independently reviewable and ships as its own PR, consistent with
the existing workflow (implement, mark `Status: DONE` here, open PR, await
approval).

### Task 1 — MCP scaffolding + shared service bootstrap
**Status:** TODO
**Description:** Add `@modelcontextprotocol/sdk`. Extract a `buildServices(config)`
helper (`src/bootstrap.ts`) that constructs the `mailboxService` (and watchers),
and refactor `server.ts` to use it. Add `src/mcp/server.ts` exporting
`createMcpServer({ mailboxService, accounts })` that returns a configured
`McpServer` with **no tools yet**, and `src/mcp-server.ts` wiring
config → services → `createMcpServer` → `StdioServerTransport`. Add `mcp` /
`mcp:dev` npm scripts.
**Acceptance criteria:** `createMcpServer` returns a server that responds to
`initialize` and `tools/list` (empty) over the SDK in-memory transport in a unit
test; `npm run mcp` starts a stdio server that a client can connect to; existing
HTTP suite still passes after the `bootstrap.ts` refactor.

### Task 2 — Discovery tools: `list_accounts`, `list_mailboxes`
**Status:** TODO
**Description:** Register the two read-only discovery tools. `list_accounts`
projects config to `{ id, host, watchMailboxes }` with **no secrets**;
`list_mailboxes` calls `mailboxService.listMailboxes`. Both declare input/output
schemas and `readOnlyHint`.
**Acceptance criteria:** Unit tests via in-memory transport assert `tools/list`
includes both, a happy-path `callTool` returns the expected structured payload,
`list_accounts` never exposes `auth`, and an unknown `accountId` returns a tool
error (not a thrown exception).

### Task 3 — Message tools: `list_messages` + `get_message` (bounded body)
**Status:** TODO
**Description:** Close the body-fetch gap at the service level — extend message
retrieval to fetch the decoded text body (prefer `text/plain`, downconvert
`text/html`), the raw source, and attachment metadata (filename, mime type,
size, part id). Implement `format.ts` compact summaries for `list_messages`
(uid, subject, from, date, flags, snippet) with default/max `limit` and
`sinceUid` paging. `get_message` returns the body text truncated to a strict,
configurable character cap; when the source body exceeds the cap it emits a
truncation marker plus a hint naming `export_message` for the full content, and
lists attachment metadata (never bytes).
**Acceptance criteria:** `list_messages` returns compact summaries (no body) and
respects limit/pagination; `get_message` returns body text capped at the
configured limit, and when the underlying body exceeds it the response is
truncated with the `export_message` hint; attachment metadata present, no bytes;
missing uid → tool error. HTTP API behavior verified unchanged (or intentionally
extended) by its existing suite. (The `export_message` hint target lands in
Task 4.)

### Task 4 — Large-payload delivery: `get_attachment`, `export_message`
**Status:** TODO
**Description:** Add `storage/blobStore.ts` that stages a blob into the
configured S3-style object store under a random key and mints a short-lived
pre-signed GET URL, and extend the zod config schema with an object-storage
block (bucket, region/endpoint, credentials, URL TTL). Implement `get_attachment`
(`accountId`, `mailbox`, `uid`, attachment part id → fetch that attachment's
bytes from IMAP, stage them, return `{ url, filename, mimeType, sizeBytes,
expiresAt }` + download hint) and `export_message` (`accountId`, `mailbox`, `uid`
→ stage the full raw RFC822 message, return the same shape). Filenames are
server-sanitized; both are `readOnlyHint`.
**Acceptance criteria:** Unit tests (mocking the object store and IMAP fetch)
assert the staged content is exactly the requested attachment / full message,
the returned metadata is correct, the pre-signed URL carries the configured TTL,
filenames are sanitized, and unknown `uid`/part id yields a tool error. An
end-to-end check confirms a returned URL actually downloads the expected bytes.

### Task 5 — Mutating tools: `move_message`, `set_flags`
**Status:** TODO
**Description:** Register the two mutating tools with correct annotations
(`move_message` destructive, `set_flags` idempotent) and clear descriptions.
`set_flags` takes `add`/`remove` string arrays; validate flag inputs.
**Acceptance criteria:** Unit tests assert correct `mailboxService` calls and
arguments, success payloads, annotation metadata, and tool errors on
unknown-mailbox / not-found conditions.

### Task 6 — Error mapping + structured-output polish
**Status:** TODO
**Description:** Centralize service-error → MCP-tool-error mapping in
`errors.ts`, reusing `isResourceNotFoundError` and `ImapConnectionError`. Ensure
every tool returns both `structuredContent` (typed) and a concise `text` summary.
**Acceptance criteria:** Tests trigger each error class (unknown account/mailbox,
connection error, unexpected error) through a tool and assert `isError` + a clear
message and stable shape; no stack traces leak to the client.

### Task 7 — (Optional) Streamable HTTP transport + auth
**Status:** TODO
**Description:** Mount the SDK's Streamable HTTP transport on the existing
Fastify app at an `/mcp` endpoint, guarded by a bearer token from config/env,
reusing the same `createMcpServer`. Keep stdio as the default entrypoint.
**Acceptance criteria:** An MCP client can connect over HTTP and call a tool;
requests without a valid token are rejected; the stdio path is unaffected.

### Task 8 — Docs
**Status:** TODO
**Description:** Document the MCP server in the README (and/or a dedicated doc):
how to run it, an example Claude Desktop / Claude Code client config, the tool
list with parameters, and the trust-boundary note.
**Acceptance criteria:** A developer can connect an MCP client to the server and
successfully call the tools using only the docs.

---

### Open questions / decisions to confirm

1. **Inline body cap** — what character limit does `get_message` enforce before
   truncating to `export_message` (e.g. ~8 KB vs ~16 KB)? Recommendation: start
   conservative and make it configurable.
2. **Object-storage staging** — stage a fresh blob per `get_attachment` /
   `export_message` call vs. cache/dedupe by message+part; and the pre-signed URL
   TTL and cleanup policy for staged blobs. Recommendation: stage-per-call with a
   short TTL and lifecycle-based expiry, revisit caching if it proves needed.
3. **HTML handling** — `get_message` downconverts `text/html` to plain text;
   `export_message` delivers raw RFC822. Confirm whether a rendered-text export
   variant is also wanted, or raw source is sufficient.
4. **Transport for v1** — stdio only (recommended), or ship Streamable HTTP in
   the first pass? Recommendation: stdio first; HTTP as Task 7.
5. **Resources** — additionally expose mailboxes/messages as MCP *resources*
   (URI-addressable) later, or keep everything as tools? Recommendation: tools
   only for v1; revisit resources once real agent usage informs the need.
