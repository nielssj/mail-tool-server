## OpenTelemetry Metrics — High-Level Solution Proposal

**Goal:** Instrument the server to emit OpenTelemetry (OTel) metrics — both
generic operational metrics (MCP request health, IMAP connection behavior)
and domain-specific metrics (mail events, mailbox operations, dispatch/export
activity) — so that whatever platform we later choose to collect and
visualize metrics on can be wired up without touching this instrumentation
again. Generic HTTP request/latency/error metrics for the plain HTTP API are
intentionally excluded — see below.

**Explicitly out of scope for this proposal:**
- Choosing/configuring a metrics backend (Prometheus, Datadog, Grafana Cloud,
  etc.), a collector, dashboards, or alerts. That's a separate, deployment-time
  concern (see "Collection is a deploy-time concern" below).
- Traces and logs-as-signals. The instrumentation seams introduced here would
  make adding OTel tracing straightforward later (same call sites), but this
  pass is metrics-only.
- Generic HTTP request-rate/latency/error-rate metrics for the plain HTTP
  API. Out of scope for this pass.

### Stack additions

- **`@opentelemetry/api`** (prod dependency) — the vendor-neutral metrics API
  (`Meter`, `Counter`, `Histogram`, `UpDownCounter`, `ObservableGauge`).
  Deliberately *not* `@opentelemetry/sdk-metrics` or any exporter package in
  production: the API package is tiny, has no transitive SDK/exporter
  dependencies, and — critically — **no-ops safely with zero configuration**
  when nothing has registered a global `MeterProvider`. This is what makes
  "collection happens separately" actually true: this repo only records
  measurements against the global API; whatever process starts the server
  decides whether those measurements go anywhere, by registering an SDK
  `MeterProvider` + exporter (e.g. via `--require ./otel-bootstrap.js` or
  `NODE_OPTIONS`) or not.
- **`@opentelemetry/sdk-metrics`** (dev dependency only) — used in unit tests
  to register an in-memory `MeterProvider`/`MeterReader` so tests can assert
  on recorded measurements. Never imported from `src/`.

### Architecture

```
src/
  telemetry/
    metrics.ts       getMeter(name) — thin factory over the global
                      `@opentelemetry/api` metrics.getMeter(), mirrors
                      utils/logger.ts's createLogger(config) factory: every
                      module gets its meter through here, never calls the
                      OTel API directly.
    instruments.ts    Single place where every instrument (Counter,
                      Histogram, UpDownCounter, ObservableGauge) is created
                      and named — call sites import the instrument, they
                      never call meter.createXxx() inline. Prevents drift
                      in naming/units/attribute keys across call sites.
    mailboxOperationMetrics.ts   withMailboxOperationMetrics(service, accounts)
                      — decorates a MailboxService object to record
                      mailtool.mailbox.operation.duration around every
                      call. mailboxService.ts itself is untouched.
    imapConnectionMetrics.ts   withConnectionMetrics(ctor) — decorates a
                      MailboxClientConstructor to record
                      mailtool.imap.connection.duration/.errors around
                      connect(); every other MailboxClient method is
                      delegated through unchanged.
    watcherMetrics.ts   observeWatcherMetrics(watcher, account) — subscribes
                      to an AccountWatcher's existing public events
                      (newMail/flagsChanged/mailRemoved/reconnecting) to
                      record counters, and registers the watcher in a
                      module-level registry that backs two ObservableGauge
                      callbacks (connection state, per-mailbox message
                      count), registered once at module load.
  server.ts   the composition root: wraps ImapFlow with
              withConnectionMetrics before handing it to
              createMailboxService, then wraps the resulting service with
              withMailboxOperationMetrics; calls observeWatcherMetrics for
              each watcher alongside the existing subscribeWatcher wiring;
              wraps each configured Dispatcher with withDispatcherMetrics
              and the BlobStore with withBlobStoreMetrics; calls
              observeMcpTransportMetrics on the MCP HTTP server.
              mailboxService.ts, webhookDispatcher.ts, mcp/errors.ts,
              mcp/httpServer.ts, mcp/tools/*.ts, and the real IMAP client
              all stay fully telemetry-free.
  imap/watcher.ts   carries three small, non-telemetry additions so
                     watcherMetrics.ts can observe it from the outside: a
                     `reconnecting` event (emitted once per reconnect
                     attempt), and two read-only methods, `isConnected()`
                     and `getMailboxMessageCount(mailbox)`. No existing
                     behavior changes.
    dispatcherMetrics.ts   withDispatcherMetrics(dispatcher) — decorates a
                      Dispatcher to record mailtool.dispatcher.webhook.duration
                      around handle(); account.id/event come off the
                      DomainEvent argument, no extra context or changes to
                      webhookDispatcher.ts needed at all.
    blobStoreMetrics.ts   withBlobStoreMetrics(blobStore) — decorates a
                      BlobStore to record mailtool.blobstore.stage.duration/
                      .bytes around stage(), tagged by the caller-supplied
                      `kind`.
  storage/blobStore.ts   `StageBlobInput` gained a required `kind:
                      'attachment' | 'message'` field, passed through by
                      its two MCP-tool callers — not used by the store
                      itself, exposed purely so a decorator can label its
                      measurements.
    mcpTransportMetrics.ts   observeMcpTransportMetrics(server) — attaches
                      an additional 'request' listener to the MCP HTTP
                      server (Node's http.Server supports multiple
                      independent listeners) to record
                      mailtool.mcp.request.duration for every POST /mcp
                      call, using plain HTTP status semantics. Zero
                      changes to mcp/httpServer.ts.
```

Nothing above changes existing return types, error behavior, or public
interfaces — every instrumentation point is a wrapper or a hook, not a
rewrite of business logic, consistent with how `withToolErrors` and the
Fastify error handler already sit alongside the code they observe rather than
inside it.

### Key design decisions

- **Collection is a deploy-time concern, not a code concern.** By coding
  against `@opentelemetry/api` only, this repo never has an opinion on where
  metrics go. Resource attributes like `service.name`/`service.version`
  (standard OTel resource conventions) are set by whoever registers the
  `MeterProvider` (typically via `OTEL_SERVICE_NAME` env var), not hardcoded
  here. If no `MeterProvider` is ever registered in a given environment, every
  `counter.add()`/`histogram.record()` call in this codebase is a cheap no-op
  — safe to ship and merge well before a collection platform exists.

- **One central instrument registry (`telemetry/instruments.ts`), not ad hoc
  `meter.createCounter()` calls scattered across files.** Same rationale as
  the existing single `createLogger` factory: naming, units, and description
  strings are easy to get inconsistent when declared inline at every call
  site, and this repo already has a precedent for "one factory, many
  callers." Adding a new metric means adding one entry here and importing it
  where needed. Call sites import it as a namespace —
  `import * as telemetry from '.../telemetry/instruments.js'` — so a
  recording reads as `telemetry.mailboxOperationDuration.record(...)` at a
  glance, rather than an unqualified `mailboxOperationDuration.record(...)`
  that looks like it could be local business-logic state (raised in review
  on Task 2's PR).

- **Decorate from the outside; don't touch the instrumented file at all.**
  Task 2 went through two revisions. First pass: a `recordMailboxOperation`
  wrapper called *from inside* `mailboxService.ts`, moved to its own file
  after review flagged it as too much utility boilerplate inline in an
  already-long file. Second pass, on further review: even calling into a
  telemetry helper from inside `mailboxService.ts` was more coupling than
  necessary, since every `MailboxService` method already shares the same
  `(accountId: string, ...) => Promise<T>` shape. The final design is a pair
  of decorators applied once at the composition root (`server.ts`), and
  `mailboxService.ts` carries zero telemetry imports or awareness:
  - `withMailboxOperationMetrics(service, accounts)` wraps the returned
    `MailboxService` object method-by-method (generic over the shared
    `(accountId, ...)` shape), recording
    `mailtool.mailbox.operation.duration`.
  - `withConnectionMetrics(ctor)` wraps a `MailboxClientConstructor`,
    delegating every `MailboxClient` method to the real client except
    `connect()`, which it times and classifies before delegating.
  Both need to recognize `ReadOnlyAccountError`/`ImapConnectionError`
  without importing them (importing back into `mailboxService.ts` would be
  circular, since `server.ts` now imports the decorators, not the other way
  around) — they match on `error.name` instead of `instanceof`; both error
  classes already set `this.name` in their constructors for exactly this
  kind of use. The one unavoidable touch point: `MailboxClientConstructor`'s
  options gained a required `id: string` field (the account id), passed
  through by `mailboxService.ts`'s existing `withClient` helper, purely so
  the connection decorator can label its measurements — not telemetry logic
  itself, just exposing account identity to whatever client gets
  constructed.

- **Same pattern for the watcher: prefer an existing public event over
  adding new surface, and add the smallest possible surface when there
  isn't one.** `AccountWatcher` already emits `newMail`/`flagsChanged`/
  `mailRemoved` publicly (the same events `events/dispatcher.ts`'s
  `subscribeWatcher` already consumes), so `watcherMetrics.ts` subscribes to
  those directly — zero changes to `watcher.ts` for those three counters.
  Two things genuinely had no public signal to observe: reconnect attempts
  (purely internal to `handleConnectionDrop`/`reconnect()`) and current
  state for the two `ObservableGauge`s (connection status, per-mailbox
  count — both need to be *read* at collection time, not just reacted to).
  For those, `watcher.ts` gained the smallest surface that makes them
  observable: a `reconnecting` event (emitted once per attempt, no
  payload — the caller already has the account) and two read-only methods,
  `isConnected()` and `getMailboxMessageCount(mailbox)`. All three are
  generically useful introspection, not telemetry-shaped — the same
  category of change as Task 2's `id` field.

- **Same pattern again for the dispatcher and blob store — both are
  single-method interfaces, so both get a pure post-hoc decorator.**
  `Dispatcher.handle(event)` and `BlobStore.stage(input)` both take
  everything a decorator needs (`event.accountId`/`event.event`,
  `input.kind`) as call arguments already — `withDispatcherMetrics` and
  `withBlobStoreMetrics` wrap them with no interface changes at all.
  `StageBlobInput` gained a required `kind` field, populated by its two
  callers in `mcp/tools/delivery.ts` (which already know whether they're
  staging an attachment or a full message) — the same move as Task 2's
  `id` field, generically useful caller-supplied context, not telemetry
  logic. `webhookDispatcher.ts` needed no change at all.

- **Dropped `mailtool.dispatcher.webhook.attempts` — redundant with the
  duration histogram's own count.** The original plan called for a
  separate counter of individual webhook POST attempts (including
  retries), which isn't visible from `handle()` alone (only the final
  outcome after retries crosses that boundary) — getting it would have
  meant threading an `onAttempt` callback into `WebhookDispatcher`'s
  constructor options. Revisited before merging: per-outcome *counts* are
  already a query over `mailtool.dispatcher.webhook.duration`'s count (the
  same "prefer one histogram over a counter family" principle applied
  elsewhere in this doc), and the actual failure mode worth watching for
  — retries making a dispatch pathologically slow — already shows up
  directly in that same duration histogram. Not worth the extra
  constructor-hook plumbing for a number the histogram already implies.

- **Dropped `mailtool.mcp.tool.duration` — accepted that
  `mailtool.mailbox.operation.duration` is close enough, given the planned
  usage pattern.** Task 5 initially implemented per-tool duration via
  `withToolMetrics('tool_name', withToolErrors(handler))`, composed at each
  of the 8 `registerTool` call sites across `mcp/tools/*.ts` (MCP tools have
  no single `MailboxService`-like object to wrap once, unlike every other
  decorator in this proposal — the realistic alternative, monkey-patching
  `McpServer.registerTool` via a `Proxy` to intercept every registration
  from one place, was rejected as coupling this codebase to a third-party
  SDK method's exact shape for a marginal reduction in touch points).
  Revisited before merging: three coverage gaps were weighed against the
  cost of 8 call-site wraps and accepted —
  1. `list_accounts` has no underlying `mailboxService` call at all, so it
     would have zero duration visibility either way. Judged acceptable for
     now; a future config-reading service shared with a possible HTTP
     accounts endpoint would give it a natural home without reviving
     per-tool MCP instrumentation.
  2. `get_attachment`/`export_message` duration would be split across two
     separate metrics (`mailtool.mailbox.operation.duration` +
     `mailtool.blobstore.stage.duration`) with a small blind gap between
     them (zod validation, formatting) — judged negligible next to the
     external I/O (IMAP fetch, S3 upload) those two metrics already cover.
  3. `mailtool.mailbox.operation.duration` still has no `surface` attribute
     (see below), so dropping the tool metric means permanently losing the
     ability to isolate MCP-triggered latency from HTTP-triggered latency
     in-app. Accepted on the bet that MCP traffic will dwarf HTTP for the
     planned usage, that a reverse proxy already reports request volume by
     route/surface, and that `mailtool.mailbox.operation.duration` will in
     practice mostly *be* the tool-call distribution anyway.
  `mailtool.mcp.request.duration` (transport-level, all `POST /mcp` calls
  regardless of JSON-RPC method) is unaffected and stays — it cost nothing
  extra (an external `'request'` listener, zero changes to
  `mcp/httpServer.ts`) and answers a different question (is the MCP
  transport itself healthy) than per-tool duration would have.

- **No generic HTTP request-rate/latency/error metrics for the plain HTTP
  API in this pass.** No `api/metricsPlugin.ts`, no `http.server.*`
  instruments. `mailtool.mailbox.operation.duration` (below) is the
  app-level signal for HTTP-triggered activity — scoped to logical
  operation and tagged by `outcome`, not raw HTTP framing.

- **Domain metrics use a project-specific `mailtool.*` namespace.** This
  keeps them clearly distinct from anything another instrumentation source
  (e.g. a future Node runtime auto-instrumentation package) might emit, and
  avoids any naming collision if generic OTel semantic-convention metrics
  are ever added in-app later.

- **Bounded-cardinality attributes only — no message UIDs, filenames,
  webhook URLs, or arbitrary caller-supplied mailbox paths as metric
  attributes.** `accountId` is safe (bounded by `config.json`). MCP tool name
  is safe (bounded, ~8 tools). Mailbox path is only used as an attribute on
  **watcher**-sourced metrics, where the set is bounded by each account's
  configured `watchMailboxes` — it is deliberately **not** attached to
  per-request `mailtool.mailbox.operation.duration` metrics, since HTTP/MCP
  callers can pass arbitrary folder paths (`Archive/2024/Q3/...`) and that
  would let an external caller blow up attribute cardinality. Destination
  mailbox on `move_message` is recorded in logs, not as a metric attribute,
  for the same reason.

- **Prefer one histogram with an `outcome` attribute over a family of
  single-purpose counters.** E.g. `mailtool.mailbox.operation.duration` is
  recorded on every call (success or failure) with `outcome` ∈
  `{success, not_found, read_only, imap_connection_error, error}` —
  per-outcome *counts* are then a query over the histogram's count, not a
  second instrument to keep in sync. This is the default; a few metrics
  below are genuinely counters/gauges because they represent something a
  duration histogram can't (event counts, reconnects, byte sizes, live
  connection state).

- **Instrument once at a shared seam, no `surface` attribute.**
  `mailboxService` is the single core both the HTTP routes and the MCP tools
  call through (per the existing "thin adapter, reuse don't reimplement"
  principle from the MCP proposal) — decorating the `MailboxService` object
  once (in `server.ts`, before it's handed to either the HTTP routes or the
  MCP tools) means operation metrics are correct and consistent for both
  without duplicating instrumentation in eight route files and eight tool
  files. `mailtool.mailbox.operation.duration` does **not** carry a `surface`
  (`http`/`mcp`) attribute: adding one would mean threading a new parameter
  through every HTTP route and MCP tool call site into `mailboxService`'s
  signature, which isn't worth the churn — this metric intentionally can't
  tell whether a given operation was HTTP- or MCP-triggered. (A per-tool
  MCP duration metric would have given that back for the MCP side
  specifically; dropped for other reasons — see the "Dropped
  `mailtool.mcp.tool.duration`" decision below.)

- **Observable (callback) gauges for "current state," synchronous
  counters/histograms for "things that happened."** Watcher connection state
  and current per-mailbox message counts are naturally *state*, already held
  in memory (`AccountWatcher`'s `client`/`mailboxCounts`) — polling it via an
  `ObservableGauge` callback avoids the awkwardness of trying to keep a
  push-based gauge in sync on every state transition, reconnect, and
  shutdown. New-mail/flags-changed/removed events are naturally *counters*.

- **Histogram bucket boundaries left at OTel SDK defaults for v1.** No
  explicit boundaries are set for any histogram (including the byte-size
  ones — `mailtool.blobstore.stage.bytes` — where mail attachment sizes are
  unlikely to match generic defaults well). `telemetry/instruments.ts`
  carries a comment flagging this for recalibration once real traffic data
  exists, rather than guessing bucket boundaries now.

### Metrics catalog

**Generic / operational**

| Name | Type | Unit | Attributes | Source |
| --- | --- | --- | --- | --- |
| `mailtool.mcp.request.duration` | Histogram | s | `outcome` (`ok`\|`error`) | `telemetry/mcpTransportMetrics.ts`'s `observeMcpTransportMetrics` (`POST /mcp`, transport-level) |
| `mailtool.imap.connection.duration` | Histogram | s | `account.id`, `outcome` (`ok`\|`error`) | `telemetry/imapConnectionMetrics.ts`'s `withConnectionMetrics` |
| `mailtool.imap.connection.errors` | Counter | {error} | `account.id` | `telemetry/imapConnectionMetrics.ts`'s `withConnectionMetrics` |

**Domain-specific**

| Name | Type | Unit | Attributes | Source |
| --- | --- | --- | --- | --- |
| `mailtool.mailbox.operation.duration` | Histogram | s | `account.id`, `operation` (`list_mailboxes`\|`list_messages`\|`get_message`\|`get_attachment`\|`get_raw_source`\|`move_message`\|`set_flags`), `outcome` | `telemetry/mailboxOperationMetrics.ts`'s `withMailboxOperationMetrics` |
| `mailtool.watcher.events` | Counter | {event} | `account.id`, `mailbox`, `event` (`newMail`\|`flagsChanged`\|`mailRemoved`) | `telemetry/watcherMetrics.ts`'s `observeWatcherMetrics`, subscribed to `AccountWatcher`'s existing public events |
| `mailtool.watcher.new_mail.messages` | Counter | {message} | `account.id`, `mailbox` | `telemetry/watcherMetrics.ts`, from the `newMail` event's `count - previousCount` (not just 1 per event) |
| `mailtool.watcher.reconnects` | Counter | {reconnect} | `account.id` | `telemetry/watcherMetrics.ts`, subscribed to `AccountWatcher`'s `reconnecting` event |
| `mailtool.watcher.connection_state` | ObservableGauge | 1 (bool) | `account.id` | `telemetry/watcherMetrics.ts` callback, reads `AccountWatcher.isConnected()` |
| `mailtool.watcher.mailbox.message_count` | ObservableGauge | {message} | `account.id`, `mailbox` | `telemetry/watcherMetrics.ts` callback, reads `AccountWatcher.getMailboxMessageCount(mailbox)` |
| `mailtool.dispatcher.webhook.duration` | Histogram | s | `account.id`, `event`, `outcome` (`ok`\|`error`) | `telemetry/dispatcherMetrics.ts`'s `withDispatcherMetrics` |
| `mailtool.blobstore.stage.duration` | Histogram | s | `kind` (`attachment`\|`message`), `outcome` | `telemetry/blobStoreMetrics.ts`'s `withBlobStoreMetrics` |
| `mailtool.blobstore.stage.bytes` | Histogram | By | `kind` | `telemetry/blobStoreMetrics.ts`'s `withBlobStoreMetrics` |

`account.id` is bounded by `config.json`; `mailbox` attributes above are only
ever populated from `watchMailboxes` (watcher-sourced), never from
caller-supplied request parameters — see cardinality decision above.

### Task Breakdown

Each task is independently reviewable and ships as its own PR, consistent
with the existing workflow (implement, mark `Status: DONE` here, open PR,
await approval).

#### Task 1 — Telemetry scaffolding
**Status:** DONE
**Description:** Add `@opentelemetry/api` (prod) and `@opentelemetry/sdk-metrics`
(dev-only, for tests) dependencies. Add `src/telemetry/metrics.ts`
(`getMeter(name: string): Meter`, thin wrapper over the global API) and
`src/telemetry/instruments.ts` (every instrument from the catalog above,
created once and exported by name — no call sites wired yet). No explicit
histogram bucket boundaries are set (OTel SDK defaults for v1); each
histogram instrument carries a short comment noting boundaries should be
recalibrated once real traffic/attachment-size data exists. Add a small
test-only helper (e.g. `src/telemetry/testing.ts`, only imported from
`test/`) that registers an in-memory `MeterProvider` + reader for assertions.
**Acceptance criteria:** Instruments can be created and recorded against with
no `MeterProvider` registered, without throwing (proves the no-op safety
claim); a unit test using the in-memory test harness asserts a recorded value
round-trips correctly; `npm run build`/`npm test` unaffected otherwise (no
call sites changed yet).

#### Task 2 — Mailbox service / IMAP connection metrics
**Status:** DONE
**Description:** `mailboxService.ts` itself is untouched except one field:
`MailboxClientConstructor`'s options gain a required `id: string` (the
account id), passed through by the existing `withClient` helper — plumbing,
not telemetry. Two decorators in `telemetry/` do the actual instrumentation:
`mailboxOperationMetrics.ts` exports `withMailboxOperationMetrics(service,
accounts)`, wrapping a `MailboxService` object method-by-method to record
`mailtool.mailbox.operation.duration` with `operation`/`outcome` attributes
(generic over all 7 methods, since they share the same `(accountId, ...)`
shape); `imapConnectionMetrics.ts` exports `withConnectionMetrics(ctor)`,
wrapping a `MailboxClientConstructor` to record
`mailtool.imap.connection.duration`/`.errors` around `connect()`, delegating
every other `MailboxClient` method unchanged. `server.ts` (the composition
root) applies both: `withConnectionMetrics(ImapFlow)` is handed to
`createMailboxService` as the client constructor, and the resulting service
is wrapped in `withMailboxOperationMetrics` before being passed to the HTTP
routes and MCP tools.
**Acceptance criteria:** Unit tests for `withMailboxOperationMetrics` (against
a trivial fake `MailboxService`, no IMAP mocking needed) assert the duration
histogram records the correct `operation`/`outcome` for a success case per
operation, a not-found case (`false` return), an out-of-bounds accountId
(labeled `"unknown"`), a `read_only` case, an `imap_connection_error` case,
and a generic `error` case. Unit tests for `withConnectionMetrics` (against a
trivial fake constructor) assert connection success/failure recording and
that every other `MailboxClient` method still delegates through correctly.
`mailboxService.test.ts` (Task 4 of the base proposal) passes unmodified,
confirming zero behavior change to the service itself.

#### Task 3 — Watcher domain metrics
**Status:** DONE
**Description:** `imap/watcher.ts` gains three small, non-telemetry
additions: a `reconnecting` event (emitted once per reconnect attempt, at
the top of `reconnect()`), and two read-only methods, `isConnected()` and
`getMailboxMessageCount(mailbox)`. No other change to the file — the three
existing domain events (`newMail`/`flagsChanged`/`mailRemoved`) were already
public. `telemetry/watcherMetrics.ts` exports `observeWatcherMetrics(watcher,
account)`, which subscribes to all four events to record
`mailtool.watcher.events`, `mailtool.watcher.new_mail.messages` (from the
`newMail` event's `count - previousCount`), and `mailtool.watcher.reconnects`,
and registers the watcher in a module-level registry backing two
`ObservableGauge` callbacks (registered once at module load) that read
`isConnected()`/`getMailboxMessageCount()` across every registered watcher —
one gauge instrument covers all accounts rather than one per watcher
instance. A paired `unobserveWatcherMetrics(account)` removes a watcher from
that registry. `server.ts` calls both alongside the existing watcher
start/stop and dispatcher-subscription wiring.
**Acceptance criteria:** Unit tests added directly to `watcher.test.ts` for
the three new `AccountWatcher` members (`reconnecting` fires once per
attempt; `isConnected()`/`getMailboxMessageCount()` reflect state correctly
across start/stop), independent of telemetry. A new `watcherMetrics.test.ts`
(real `AccountWatcher` + mocked IMAP client, same pattern as
`watcher.test.ts`) asserts: `exists`/`flags`/`expunge` events on the mocked
connection produce the correct counters with correct attributes; a simulated
disconnect+reconnect increments the reconnect counter; the observable gauges
report the expected connection state and message count while a watcher is
registered, correctly reflect a disconnect, and report independently for two
concurrent watchers.

#### Task 4 — Dispatcher + blob store metrics
**Status:** DONE
**Description:** `telemetry/dispatcherMetrics.ts` exports
`withDispatcherMetrics(dispatcher)`, decorating any `Dispatcher` to record
`mailtool.dispatcher.webhook.duration` around `handle()` (`account.id`/
`event` read straight off the `DomainEvent` argument — no interface changes,
no changes to `webhookDispatcher.ts` at all). `telemetry/blobStoreMetrics.ts`
exports `withBlobStoreMetrics(blobStore)`, decorating any `BlobStore` to
record `mailtool.blobstore.stage.duration`/`.bytes` around `stage()`, tagged
by `kind`. `storage/blobStore.ts`'s `StageBlobInput` gained a required
`kind: 'attachment' | 'message'` field, populated by its two callers in
`mcp/tools/delivery.ts`. `server.ts` wires both: each configured `Dispatcher`
is wrapped with `withDispatcherMetrics`, and the `BlobStore` is wrapped with
`withBlobStoreMetrics`. The originally-planned
`mailtool.dispatcher.webhook.attempts` counter (and the `onAttempt`
constructor hook it would have needed on `WebhookDispatcher`) was dropped
before merging — see the "Dropped `mailtool.dispatcher.webhook.attempts`"
design decision above.
**Acceptance criteria:** New `dispatcherMetrics.test.ts` asserts duration/
outcome recorded correctly on success and failure, against a stub
`Dispatcher`. New `blobStoreMetrics.test.ts` (against a stub `BlobStore`)
asserts duration/byte-size recorded correctly for both an attachment and a
full-message stage call, and that bytes are only recorded on success.
Existing `blobStore.test.ts`/`mcpDeliveryTools.test.ts` updated for the new
required `kind` field; both pass otherwise unmodified.
`webhookDispatcher.test.ts`/`events/dispatcher.ts` pass unmodified —
confirmed via `git diff origin/main -- src/events/dispatchers/webhookDispatcher.ts
src/events/dispatcher.ts` showing no diff.

#### Task 5 — MCP transport metrics
**Status:** DONE
**Description:** `telemetry/mcpTransportMetrics.ts` exports
`observeMcpTransportMetrics(server)`, attaching an additional `'request'`
listener to the MCP HTTP server to record `mailtool.mcp.request.duration`
using plain HTTP status semantics — `mcp/httpServer.ts` is untouched.
`server.ts` calls `observeMcpTransportMetrics` on the MCP HTTP server
alongside its existing startup wiring. Per-tool duration
(`mailtool.mcp.tool.duration`) was implemented and then dropped before
merging — see the "Dropped `mailtool.mcp.tool.duration`" design decision
above. `mcp/tools/*.ts` and `mcp/errors.ts` are consequently untouched by
this task entirely.
**Acceptance criteria:** New `mcpTransportMetrics.test.ts` starts a real
`createMcpHttpServer` instance and asserts `mailtool.mcp.request.duration`
is recorded with `outcome: "ok"` for a real `POST /mcp` `initialize` call
and `outcome: "error"` for a transport-level failure (`GET /mcp` → 405).
All 8 existing MCP tool test files pass unmodified. `git diff origin/main
-- src/mcp/errors.ts src/mcp/httpServer.ts src/mcp/server.ts src/mcp/tools/`
is empty.

#### Task 6 — Docs
**Description:** New `docs/metrics.md`: the full metrics catalog (name,
type, unit, attributes, description, source) as the authoritative reference
for whoever configures collection — effectively the "what you can scrape"
contract. README gets a short "Metrics" section: what's emitted, the
no-op-by-default behavior, and a pointer to `docs/metrics.md` plus a
one-line example of registering a `MeterProvider` (e.g. via an OTLP
exporter) to actually collect them, explicitly marked as
illustrative/deploy-time, not part of the running server.
**Acceptance criteria:** `docs/metrics.md` lists every instrument from Tasks
1–5 with correct final attribute names (kept in sync with what actually
shipped, not just this proposal's draft names); a developer can read it and
know exactly what to expect from a scrape without reading source.

---

### Resolved decisions

1. **Namespace prefix** — `mailtool.` for domain metrics.
2. **No `surface` attribute** — `mailtool.mailbox.operation.duration` isn't
   tagged with `http`/`mcp`; not worth threading a new parameter through
   `mailboxService`'s signature and every call site for it. MCP-specific
   granularity still comes from `mailtool.mcp.tool.duration`.
3. **No bundled exporter** — this repo stays instrumentation-only against
   `@opentelemetry/api`; no dev-mode console/Prometheus exporter is added.
   Collection setup (including for local dev, if ever wanted) is entirely a
   separate, later concern.
4. **Histogram bucket boundaries** — left at OTel SDK defaults for v1;
   `instruments.ts` carries a comment flagging recalibration once real
   traffic/attachment-size data exists.
5. **Scope** — metrics only, no tracing, in this pass.
