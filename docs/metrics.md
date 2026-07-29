# Metrics

mail-tool-server instruments itself with [OpenTelemetry](https://opentelemetry.io/)
(OTel) metrics. This is the authoritative reference for every metric it can
emit — names, types, units, attributes, and where each one is recorded —
kept in sync with what's actually in `src/telemetry/instruments.ts`, so you
know exactly what to expect once you point a collector at it.

## Collection: an opt-in bootstrap, not on by default

Application code (`src/`, minus the bootstrap module below) only calls into
`@opentelemetry/api` — no SDK, no exporter, no collection configuration is
loaded unless you ask for it. Every instrument below is a safe no-op until
*something* registers a global `MeterProvider` for this process. That's
still a separate, deploy-time concern this repo doesn't wire into
`npm start`/`npm run dev`/tests (see
[`docs/proposal/otel-metrics-proposal.md`](proposal/otel-metrics-proposal.md)
for the full reasoning) — but the repo now ships that piece too, as an
opt-in preload module rather than leaving it entirely to the deployer.

`src/otel-bootstrap.ts` (compiled to `dist/otel-bootstrap.js`) registers a
`MeterProvider` backed by `@opentelemetry/exporter-prometheus`: a **pull**
exporter that starts its own tiny HTTP server on port `9464` and serves
`GET /metrics` in Prometheus exposition format — it does not push anything
to a collector on its own, and it doesn't touch the app's own Fastify
servers on `3000`/`3001`. Deliberately not an OTLP push exporter and not
`@opentelemetry/sdk-node` (which pulls in auto-instrumentation/tracing
machinery this repo doesn't want) — just `@opentelemetry/sdk-metrics` +
`@opentelemetry/exporter-prometheus` registering a `MeterProvider` for the
existing `@opentelemetry/api` calls to resolve against.

To enable it, preload the bootstrap module before the server starts:

```bash
node --import ./dist/otel-bootstrap.js dist/server.js
```

The published Docker image already does this by default (see `Dockerfile`'s
`CMD` and `EXPOSE 3000 3001 9464`) — collection is opt-in for anyone running
`dist/server.js` directly, but on for anyone running the container image.

Resource attributes like `service.name` come from the `OTEL_SERVICE_NAME` /
`OTEL_RESOURCE_ATTRIBUTES` env vars (via `@opentelemetry/resources`'
`envDetector`) — this server never hardcodes them. If you'd rather ship
metrics to a different backend (e.g. an OTLP collector), replace or extend
`src/otel-bootstrap.ts` with the SDK distribution and exporter your platform
expects; nothing else in this repo depends on Prometheus specifically.

## Naming and attribute conventions

- Every domain-specific metric uses a `mailtool.` prefix, kept distinct from
  OTel semantic-convention names (e.g. `http.server.*`) another
  instrumentation source might add later.
- `account.id` attributes are always a bounded, config-defined account id
  from `config.json` — or the literal string `"unknown"` for an
  out-of-bounds id — never arbitrary caller input.
- `mailbox` attributes only ever appear on watcher-sourced metrics, bounded
  by each account's configured `watchMailboxes`. They're deliberately
  **not** attached to per-request operation metrics, since HTTP/MCP callers
  can pass arbitrary folder paths.
- Where a histogram's `outcome` attribute already lets you derive
  per-outcome counts from its count, no separate counter is also provided.
- `mailtool.mailbox.operation.duration` is recorded for both HTTP- and
  MCP-triggered calls with no attribute distinguishing which — see
  `docs/proposal/otel-metrics-proposal.md` for why.

## Generic / operational metrics

| Name | Type | Unit | Attributes | Description | Source |
| ---- | ---- | ---- | ---------- | ------------ | ------ |
| `mailtool.mcp.request.duration` | Histogram | s | `outcome` (`ok`\|`error`) | Duration of a `POST /mcp` transport-level request, covering any JSON-RPC method (not just tool calls). Outcome is plain HTTP status semantics: `< 400` → `ok`. | `telemetry/mcpTransportMetrics.ts` |
| `mailtool.imap.connection.duration` | Histogram | s | `account.id`, `outcome` (`ok`\|`error`) | Duration of opening a short-lived IMAP connection for a `mailboxService` call. | `telemetry/imapConnectionMetrics.ts` |
| `mailtool.imap.connection.errors` | Counter | {error} | `account.id` | Count of failed IMAP connection attempts. | `telemetry/imapConnectionMetrics.ts` |

## Domain-specific metrics

| Name | Type | Unit | Attributes | Description | Source |
| ---- | ---- | ---- | ---------- | ------------ | ------ |
| `mailtool.account.operation.duration` | Histogram | s | `operation` (`list_accounts`), `outcome` (`success`\|`error`) | Duration of an `accountService` operation. Only `list_accounts` exists today. | `telemetry/accountOperationMetrics.ts` |
| `mailtool.mailbox.operation.duration` | Histogram | s | `account.id`, `operation` (`list_mailboxes`\|`list_messages`\|`get_message`\|`get_attachment`\|`get_raw_source`\|`move_message`\|`set_flags`), `outcome` (`success`\|`not_found`\|`read_only`\|`imap_connection_error`\|`error`) | Duration of a `mailboxService` operation. | `telemetry/mailboxOperationMetrics.ts` |
| `mailtool.watcher.events` | Counter | {event} | `account.id`, `mailbox`, `event` (`newMail`\|`flagsChanged`\|`mailRemoved`) | Count of IMAP watcher domain events. | `telemetry/watcherMetrics.ts` |
| `mailtool.watcher.new_mail.messages` | Counter | {message} | `account.id`, `mailbox` | Count of new messages observed by the watcher — one `newMail` event is already exactly one message, so this increments by 1 per event. | `telemetry/watcherMetrics.ts` |
| `mailtool.watcher.reconnects` | Counter | {reconnect} | `account.id` | Count of watcher IDLE connection reconnect attempts. | `telemetry/watcherMetrics.ts` |
| `mailtool.watcher.connection_state` | ObservableGauge | 1 | `account.id` | Whether an account watcher currently holds a live IMAP connection (`1`) or not (`0`). | `telemetry/watcherMetrics.ts` |
| `mailtool.watcher.mailbox.message_count` | ObservableGauge | {message} | `account.id`, `mailbox` | Last-known message count for a watched mailbox, as tracked by the watcher. | `telemetry/watcherMetrics.ts` |
| `mailtool.dispatcher.webhook.duration` | Histogram | s | `account.id`, `event` (`newMail`\|`flagsChanged`\|`mailRemoved`), `outcome` (`ok`\|`error`) | Duration of a webhook dispatch, including any retries — reflects the final outcome after all attempts, not each individual POST. | `telemetry/dispatcherMetrics.ts` |
| `mailtool.blobstore.stage.duration` | Histogram | s | `kind` (`attachment`\|`message`), `outcome` (`ok`\|`error`) | Duration of staging a blob (attachment or full exported message) into object storage. | `telemetry/blobStoreMetrics.ts` |
| `mailtool.blobstore.stage.bytes` | Histogram | By | `kind` (`attachment`\|`message`) | Size in bytes of a blob staged into object storage. Only recorded when staging succeeds. | `telemetry/blobStoreMetrics.ts` |

## Histogram bucket boundaries

Every histogram above uses OTel SDK default bucket boundaries — no explicit
`advice.explicitBucketBoundaries` are set anywhere in
`telemetry/instruments.ts`. This includes the byte-size histogram
(`mailtool.blobstore.stage.bytes`), where mail attachment sizes are unlikely
to match generic defaults well. Revisit once real traffic/attachment-size
data exists, rather than guessing boundaries now.
