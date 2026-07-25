# Metrics

mail-tool-server instruments itself with [OpenTelemetry](https://opentelemetry.io/)
(OTel) metrics. This is the authoritative reference for every metric it can
emit — names, types, units, attributes, and where each one is recorded —
kept in sync with what's actually in `src/telemetry/instruments.ts`, so you
know exactly what to expect once you point a collector at it.

## Collection is not built in

The server only calls into `@opentelemetry/api` — there is no
`@opentelemetry/sdk-metrics`, no exporter, and no collection configuration
bundled into `src/`. Every instrument below is a safe no-op until
*something* registers a global `MeterProvider` for this process, which is a
separate, deploy-time concern this repo deliberately doesn't own (see
[`docs/proposal/otel-metrics-proposal.md`](proposal/otel-metrics-proposal.md)
for the full reasoning).

To actually collect these metrics, register an SDK `MeterProvider` +
exporter **before** any application code loads — e.g. via a `--require`/
`--import` preload module, using whatever OTel SDK distribution and exporter
your collection platform expects. A minimal, illustrative example (not part
of this server, not tested or maintained here — just a starting point):

```js
// otel-bootstrap.js — illustrative only, not part of this server
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

new NodeSDK({
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter()
  })
}).start();
```

```bash
node --import ./otel-bootstrap.js dist/server.js
```

Resource attributes like `service.name`/`service.version` are set by
whichever `MeterProvider` you register (typically via the `OTEL_SERVICE_NAME`
env var) — this server never hardcodes them.

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
