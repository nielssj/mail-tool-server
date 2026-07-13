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
  services/mailboxService.ts   wraps each operation + the shared IMAP
                                connection helper to record operation and
                                connection metrics.
  imap/watcher.ts               records domain event counters + registers
                                 observable gauges for connection state and
                                 per-mailbox message counts.
  events/dispatchers/webhookDispatcher.ts   records dispatch outcome/timing.
  storage/blobStore.ts                      records staging outcome/timing/size.
  mcp/errors.ts        withToolErrors gains a sibling (or is extended) to
                        also record per-tool call metrics — one wrapper,
                        every tool covered, same pattern already used for
                        error mapping.
  mcp/httpServer.ts    records overall /mcp request duration.
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

- **Instrumentation logic that's more than a one-line call at the recording
  site lives in its own module under `telemetry/`, not inline in the
  business-logic file it instruments.** Task 2's outcome-classification +
  wrapper logic (`recordMailboxOperation`) was initially written directly in
  `mailboxService.ts`; review feedback moved it to
  `telemetry/mailboxOperationMetrics.ts` since it was adding a lot of
  utility boilerplate to an already-long file. Where this creates a
  potential circular import (e.g. the extracted module needing to recognize
  error types defined in the file it instruments), prefer matching on
  `error.name` over `instanceof` rather than importing the error class back
  in — both `ReadOnlyAccountError` and `ImapConnectionError` already set
  `this.name` in their constructors for exactly this kind of use.

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
  principle from the MCP proposal) — instrumenting `mailboxService` itself
  means operation metrics are correct and consistent for both without
  duplicating instrumentation in eight route files and eight tool files.
  `mailtool.mailbox.operation.duration` does **not** carry a `surface`
  (`http`/`mcp`) attribute: adding one would mean threading a new parameter
  through every HTTP route and MCP tool call site into `mailboxService`'s
  signature, which isn't worth the churn — this metric intentionally can't
  tell whether a given operation was HTTP- or MCP-triggered.
  `mailtool.mcp.tool.duration` (recorded separately, at the `withToolErrors`
  seam) still gives full per-tool granularity for the MCP side specifically.

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
| `mailtool.mcp.request.duration` | Histogram | s | `outcome` (`ok`\|`error`) | `mcp/httpServer.ts` (`POST /mcp`, transport-level) |
| `mailtool.mcp.tool.duration` | Histogram | s | `tool`, `outcome` (`ok`\|error code from `errors.ts`) | `mcp/errors.ts` wrapper |
| `mailtool.imap.connection.duration` | Histogram | s | `account.id`, `outcome` (`ok`\|`error`) | `mailboxService`'s `withClient` |
| `mailtool.imap.connection.errors` | Counter | {error} | `account.id` | `mailboxService`'s `withClient` |

**Domain-specific**

| Name | Type | Unit | Attributes | Source |
| --- | --- | --- | --- | --- |
| `mailtool.mailbox.operation.duration` | Histogram | s | `account.id`, `operation` (`list_mailboxes`\|`list_messages`\|`get_message`\|`get_attachment`\|`get_raw_source`\|`move_message`\|`set_flags`), `outcome` | `mailboxService` wrapper |
| `mailtool.watcher.events` | Counter | {event} | `account.id`, `mailbox`, `event` (`newMail`\|`flagsChanged`\|`mailRemoved`) | `imap/watcher.ts` handlers |
| `mailtool.watcher.new_mail.messages` | Counter | {message} | `account.id`, `mailbox` | `imap/watcher.ts` `handleExists` (incremented by `count - previousCount`, not just 1 per event) |
| `mailtool.watcher.reconnects` | Counter | {reconnect} | `account.id` | `imap/watcher.ts` `handleConnectionDrop`/`reconnect` |
| `mailtool.watcher.connection_state` | ObservableGauge | 1 (bool) | `account.id` | `imap/watcher.ts`, callback reads `this.client != null` |
| `mailtool.watcher.mailbox.message_count` | ObservableGauge | {message} | `account.id`, `mailbox` | `imap/watcher.ts`, callback reads `mailboxCounts` map |
| `mailtool.dispatcher.webhook.duration` | Histogram | s | `account.id`, `event`, `outcome` (`ok`\|`error`) | `webhookDispatcher.ts` |
| `mailtool.dispatcher.webhook.attempts` | Counter | {attempt} | `account.id`, `outcome` | `webhookDispatcher.ts` `postWithRetry` |
| `mailtool.blobstore.stage.duration` | Histogram | s | `kind` (`attachment`\|`message`), `outcome` | `storage/blobStore.ts` `stage()` |
| `mailtool.blobstore.stage.bytes` | Histogram | By | `kind` | `storage/blobStore.ts` `stage()` |

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
**Description:** Extend `mailboxService`'s `withClient` helper to record
`mailtool.imap.connection.duration`/`mailtool.imap.connection.errors`, and
wrap each of the seven service methods to record
`mailtool.mailbox.operation.duration` with `operation`/`outcome` attributes.
No signature changes to `mailboxService`'s public methods — instrumentation
wraps the existing implementations internally.
**Acceptance criteria:** Unit tests (mocked `ImapFlow`, existing pattern)
assert each of the 7 operations records the duration histogram with the
correct `operation`/`outcome` for a success case, a not-found case, and a
thrown-error case; connection metrics recorded on both connect success and
`ImapConnectionError`.

#### Task 3 — Watcher domain metrics
**Description:** In `imap/watcher.ts`, record `mailtool.watcher.events` and
`mailtool.watcher.new_mail.messages` inside `handleExists`/`handleFlags`/
`handleExpunge`; record `mailtool.watcher.reconnects` in
`handleConnectionDrop`. Register `mailtool.watcher.connection_state` and
`mailtool.watcher.mailbox.message_count` as `ObservableGauge` callbacks —
since gauges are process-global instruments but watchers are per-account
instances, maintain a small module-level registry of live `AccountWatcher`s
(populated on `start()`, cleared on `stop()`) that the callback iterates, so
one gauge covers all accounts rather than one gauge per watcher instance.
**Acceptance criteria:** Unit tests simulate `exists`/`flags`/`expunge`
events on a mocked connection (existing test pattern) and assert the correct
counters increment with correct attributes; a simulated disconnect+reconnect
increments the reconnect counter; the observable gauges report the expected
connection state and message count when read via the in-memory test harness,
for multiple concurrent watcher instances.

#### Task 4 — Dispatcher + blob store metrics
**Description:** `webhookDispatcher.ts`'s `postWithRetry` records
`mailtool.dispatcher.webhook.duration` and `.attempts` per call (final
outcome after retries, plus an attempt count). `storage/blobStore.ts`'s
`stage()` records `mailtool.blobstore.stage.duration` and `.bytes` (from
`input.body.length`), tagged with `kind` derived from the caller (attachment
vs. full-message export — passed in by the two MCP tools calling `stage()`).
**Acceptance criteria:** Unit tests (mocked `fetch`/mocked S3 client,
existing patterns) assert duration/attempt/outcome recorded correctly on
first-try success, retry-then-success, and exhausted-retries failure for the
webhook dispatcher; blob store test asserts byte size and `kind` recorded
correctly for both an attachment and a full-message stage call.

#### Task 5 — MCP tool + transport metrics
**Description:** Extend (or add a sibling to) `mcp/errors.ts`'s
`withToolErrors` to also record `mailtool.mcp.tool.duration` with `tool`
(passed in at registration, since the wrapper doesn't otherwise know the
tool's name) and `outcome` (`ok` or the mapped error code). Record
`mailtool.mcp.request.duration` in `mcp/httpServer.ts`'s `handleMcpRequest`
for overall transport-level timing.
**Acceptance criteria:** Unit tests via the SDK's in-memory transport
(existing MCP test pattern) assert each tool call records the duration
histogram with correct `tool`/`outcome` for a success and at least one error
case; an HTTP-level test asserts `mailtool.mcp.request.duration` is recorded
for a real `POST /mcp` call.

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
