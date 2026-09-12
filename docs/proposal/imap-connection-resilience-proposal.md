## IMAP Connection Resilience — High-Level Plan

**Goal:** Stop the weekly IMAP connection drop from producing `error`-level
log lines (and the Grafana alert groups they generate), while keeping a
genuine, alertable signal when connectivity is actually broken rather than
merely blipping.

**Trigger:** Roughly once a week the deployed instance emits an error-level
burst into Loki. The stated assumption was that the connection "is
established immediately again, with supposedly no real consequences for
operations." Investigating the actual log lines showed that assumption does
not hold — see below.

---

### What the logs actually show

Querying `{service_name="mail-tool-server"} | detected_level="error"` over
2026-08-01 → 2026-09-12 returns **9 lines across exactly 3 incidents**
(2026-08-30 21:00:54Z, 2026-09-07 22:17:41Z, 2026-09-08 20:20:24Z) — the
weekly cadence described. Pulling the full `stderr` stream for one incident
gives the whole picture:

```
node:events:487
      throw er; // Unhandled 'error' event
      ^

Error: read ECONNRESET
    at TLSWrap.onStreamRead (node:internal/stream_base_commons:216:20)
Emitted 'error' event on ImapFlow instance at:
    at ImapFlow.emitError (/app/node_modules/imapflow/lib/imap-flow.js:452:14)
    at TLSSocket.<anonymous> (/app/node_modules/imapflow/lib/imap-flow.js:933:22)
    at Object.onceWrapper (node:events:631:26)
    at TLSSocket.emit (node:events:509:28)
    at emitErrorNT (node:internal/streams/destroy:170:8)
    at emitErrorCloseNT (node:internal/streams/destroy:129:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
  errno: -104,
  code: 'ECONNRESET',
  syscall: 'read',
  _connId: 't13by79h0g1mlytkfw9b'
}

Node.js v24.19.0
```

Two conclusions follow, and both change the shape of the fix:

**1. These are not application log lines.** Not one of them came from
`pino`. This is Node's own fatal-exception dump written raw to `stderr`;
Loki's `detected_level` heuristic classifies it as `error`. No pino level
change, no log filter, and no retry-before-logging policy inside the
watcher can suppress it, because nothing in our code is doing the logging.

**2. The process is crashing, not reconnecting.** The trailing
`Node.js v24.19.0` line is the runtime's fatal-exit footer. The container
dies and Kubernetes restarts it. The evidence is unambiguous: the entire
`stdout` stream for the same six-week window contains exactly three lines —

```
1788819474991  {"level":"info", ... "msg":"MCP server listening at http://0.0.0.0:3001/mcp"}
1788819475154  {"level":"info", ... "msg":"Server listening at http://127.0.0.1:3000"}
1788819475154  {"level":"info", ... "msg":"Server listening at http://10.42.0.165:3000"}
```

— a cold-start sequence at 2026-09-07T22:17:55Z, **14 seconds after** the
`ETIMEDOUT` crash at 22:17:41Z on that same date. What looks like "the
connection is re-established immediately" is the pod coming back up.

So the real consequences are larger than assumed: in-flight HTTP and MCP
requests are dropped mid-flight, `shutdown()` never runs (no graceful
close, no `watcher.stop()`), MCP Streamable-HTTP sessions are lost, and all
process-local metric counters reset to zero. It is cheap because the
service is mostly idle at 03:00 — it would not be cheap under load.

### Root cause

`AccountWatcher.attachClientListeners` (`src/imap/watcher.ts`) subscribes to
`exists`, `flags`, `expunge` and `close` — but **not** `error`:

```ts
private attachClientListeners(client: WatcherClient): void {
  client.on('exists', this.handleExists);
  client.on('flags', this.handleFlags);
  client.on('expunge', this.handleExpunge);
  client.on('close', this.handleClose);
}
```

`ImapFlow` extends `EventEmitter` and calls `emitError()` when its socket
fails. Node's `EventEmitter` contract is that an `'error'` event with no
registered listener is **rethrown as an uncaught exception**. An idle IMAP
connection sitting in `IDLE` for hours is exactly the thing a NAT gateway or
mail provider eventually reaps with an RST or a silent timeout, which is why
this reliably surfaces about once a week.

The same gap exists in `src/imap/clientFactory.ts` and the short-lived
clients `mailboxService` creates per operation — a mid-operation reset there
would crash the process the same way. It just fires far less often because
those connections live for seconds, not hours.

There is no `process.on('uncaughtException')` net anywhere in `src/`.

### Secondary finding: the watcher's logger is never wired up

`AccountWatcher` accepts `options.logger` and defaults to `noopLogger`.
`src/server.ts` constructs watchers as `new AccountWatcher(account)` — no
options. Every `this.logger.error(...)` / `this.logger.warn(...)` in the
watcher (the IDLE-loop failure, the mailbox-open failure, the reconnect
failure, the UID-enrichment failure) is therefore **dead code in
production**: it writes to a no-op.

This matters for sequencing. Fixing only the crash would make the incident
silent rather than correct — and fixing only the logger would turn today's
one-a-week crash into a steady stream of genuine `error` lines, i.e. more
Grafana noise, not less. Both have to land together with the escalation
policy below.

### Reconnect policy today

`handleConnectionDrop()` schedules a reconnect on a fixed
`DEFAULT_RECONNECT_DELAY_MS = 1_000` with no backoff, no jitter, and no
attempt ceiling. Against a provider that is briefly refusing connections
this is a 1-per-second hammer, which is the case most likely to get an IP
rate-limited. The `mailtool.watcher.reconnects` counter and the
`mailtool.watcher.connection.state` gauge already exist and are already
wired in `observeWatcherMetrics` — that telemetry is sound and is the right
long-term basis for alerting.

---

### Proposed approach

The principle: **a transient drop is a normal event in the life of a
long-lived IMAP connection and should be recorded, not alerted on. An
`error` log should mean "this did not heal."**

#### 1. Never let a socket error reach Node's uncaught handler

Register an `error` listener on every `ImapFlow` instance at construction.

- In `AccountWatcher`: add `client.on('error', this.handleError)` to
  `attachClientListeners` (and the matching `off` in
  `detachClientListeners`). `handleError` records the cause and routes into
  the existing `handleConnectionDrop()` path, which already tears the client
  down and schedules a reconnect. `close` usually follows an `error`, so
  `handleConnectionDrop()` needs to stay idempotent for one drop — it mostly
  is (it nulls `this.client` first), but the `reconnectTimer` guard should
  be verified against the error-then-close ordering rather than assumed.
- In `clientFactory.ts` / `mailboxService`'s per-operation clients: attach a
  listener that rejects or records against the in-flight operation instead
  of escalating to the process. These clients are short-lived, so the goal
  is narrower — turn a crash into a failed request.

#### 2. Escalate to `error` only when the drop does not heal

Add a small reconnect-supervision state machine to `AccountWatcher`, with
thresholds as constructor options so they stay testable and tunable:

- **Consecutive-failure threshold.** Reconnect attempts log at `debug`;
  after `N` consecutive failed attempts (default in the 5-ish range,
  spanning ~1 minute with the backoff below), escalate to one `error`.
- **Recovery.** A reconnect that succeeds resets the counter and logs a
  single `info` recovery line naming the outage duration and attempt count
  — so an operator reading the log after the fact sees one tidy "dropped,
  back after 3s, 2 attempts" record instead of either silence or a stack
  trace.

**Deliberately not included: in-process flap detection.** An earlier draft
proposed a second escalation rule — "M drops inside window W" — to catch a
connection that reconnects successfully but keeps dropping. That rule is
dropped; see "Why flap detection stays out of the process" below. The
consecutive-failure counter stays, because it is effectively free (the
backoff schedule already has to track the attempt number) and because it
describes something no scraped metric can see: whether the retry loop is
currently stuck.
- Steady-state, the once-a-week ECONNRESET produces **one `info` line and
  zero `error` lines**, and Grafana stays quiet.

#### 3. Exponential backoff with jitter

Replace the fixed 1s delay with exponential backoff (1s base, capped
around 30–60s) plus jitter. Keeps fast recovery for the common case, stops
the hammer in the sustained-outage case, and staggers accounts so several
watchers do not retry in lockstep.

#### 4. Wire the real logger through from `server.ts`

Pass the existing pino instance into each `AccountWatcher`, so the
supervision policy above actually reaches stdout as structured JSON (with
`accountId`, attempt count, error `code`) rather than a no-op. This also
means future watcher failures stop being invisible.

#### 5. Keep metrics, not logs, as the alerting substrate

`mailtool_watcher_reconnects_total` and `mailtool_watcher_connection_state`
are already being scraped into Grafana Cloud Prometheus (verified against
`grafanacloud-prom`; both carry an `account_id` label). Once the crash is
fixed they become continuously meaningful — today they reset on every
crash, which is plainly visible in the series.

**Alert on the reconnect counter, not on the connection-state gauge.** The
gauge queried over five days at 5-minute resolution is a flat, unbroken
`1` — it never once records a drop, because drops heal in about a second
and fall entirely between scrapes. A `connection_state == 0` alert would
essentially never fire for this failure mode. The counter, by contrast,
captures every drop regardless of duration, and the burst structure is
already legible in it (see below). The recommended rule is therefore on
`increase(mailtool_watcher_reconnects_total[30m])`, with the log-based
alert group left to serve only the escalated `error` case.

Worth a short follow-up note in `docs/metrics.md`; the Grafana-side alert
rule change itself is out of scope for this repo.

### Why flap detection stays out of the process

The reconnect counter over the last 14 days settles the question. Reading
`mailtool_watcher_reconnects_total` for `account_id="inbox"`:

| Window | Counter | Reading |
| --- | --- | --- |
| ~2026-08-27 | `54` → `58` | **4 reconnects inside one hour** — a burst |
| next ~40h | flat at `58` | healthy |
| 2026-08-30 21:00 | resets to `6` | crash (counter restarts) |
| 2026-08-30 → 09-07 | `6` → `15` | 9 drops over ~8 days, all healed |
| 2026-09-07 22:17 | resets to `4` | crash |

Two things follow. First, drops that heal are **already routine** — dozens
between crashes — so they were never going to be a useful error signal in
the first place. Second, the flapping condition that in-process detection
was meant to catch is *already fully visible in the metric*: the
`54 → 58`-in-an-hour burst is exactly "M drops inside W", expressed in the
system that is designed to express it.

So the honest answer to whether the in-process rule earns its complexity,
given section 5: **no.** Concretely, it would cost the watcher a timestamp
ring buffer, a separate "stable for W" recovery timer, reset semantics that
interact with the consecutive-failure counter, and a set of tests for the
interaction between the two — while duplicating a query that is one line of
PromQL:

```promql
increase(mailtool_watcher_reconnects_total[30m]) > 5
```

The PromQL version is also strictly better on three counts: the threshold
is tunable without a redeploy, it is evaluated across accounts and pods
rather than per-process, and it survives a restart (`increase()` handles
counter resets, which — as the table above shows — this series genuinely
has).

The consecutive-failure threshold is a different case and stays. It gates
the `error` log, it needs only an integer the backoff loop already
maintains, and it distinguishes "the retry loop is stuck right now" from
"reconnected fine" — a distinction a 60-second scrape cannot draw when the
event it is trying to see lasts one second.

### Open question for review

**Should we also add a `process.on('uncaughtException')` last-resort
handler?** It would guarantee that no future unhandled emitter error takes
the process down silently, and would let us log the crash through pino
before exiting. The argument against is that it can mask real bugs and
leave the process in an undefined state. My recommendation is to add one
that logs and then **still exits non-zero** — a safety net for
observability, not a way to keep running through unknown faults. Flagging
it rather than deciding it, since it changes failure semantics
process-wide.

---

### Task Breakdown

#### Task 1 — Watcher error handling, reconnect supervision, and logging
**Status:** TODO
**Description:**
- Add an `error` listener to `attachClientListeners` /
  `detachClientListeners` in `src/imap/watcher.ts`, routing into
  `handleConnectionDrop()`; extend the `WatcherClientEvents` type with
  `error: (err: Error) => void`.
- Verify/repair `handleConnectionDrop()` idempotency for the
  error-then-close event ordering so one drop schedules one reconnect.
- Add reconnect supervision: a consecutive-failure counter with an
  escalation threshold, reset on a successful reconnect; threshold exposed
  via `AccountWatcherOptions`. No flap window — see the section above.
- Replace the fixed `reconnectDelayMs` with exponential backoff + jitter,
  configurable and injectable for tests.
- Emit `debug` per attempt, one `error` on escalation, one `info` on
  recovery — all structured with `accountId`, attempt count, error code.
- Pass the pino logger into `new AccountWatcher(...)` in `src/server.ts`.
- Extend `test/watcher.test.ts`: a single drop that heals produces no
  `error` log; `N` consecutive failures produce exactly one; repeated drops
  inside the flap window escalate; a healed-and-stable connection resets the
  counters; backoff delays grow and are capped.

**Acceptance criteria:**
- An `error` emitted by the mock client no longer propagates as an uncaught
  exception and triggers exactly one reconnect cycle.
- A single transient drop logs zero `error` lines.
- Escalation fires after the configured number of consecutive failures and
  resets on a successful reconnect.
- `npm run lint`, `npx tsc --noEmit` and `npm test` pass.

#### Task 2 — Error handling for short-lived operation clients
**Status:** TODO
**Description:**
- Attach `error` listeners in `src/imap/clientFactory.ts` and to the
  per-operation clients in `src/services/mailboxService.ts`, so a
  mid-operation socket reset surfaces as a failed request (mapped through
  the existing `ImapConnectionError` / error-handler path) rather than a
  process crash.
- Decide and implement the `process.on('uncaughtException')` question above
  per review outcome.
- Tests in `test/clientFactory.test.ts` / `test/mailboxService.test.ts`
  covering a client that emits `error` mid-operation.

**Acceptance criteria:**
- A socket error during an in-flight operation rejects that operation and
  leaves the process alive.
- `npm run lint`, `npx tsc --noEmit` and `npm test` pass.

#### Task 3 — Documentation
**Status:** TODO
**Description:**
- Document the new reconnect/escalation behaviour and its tunables in
  `README.md`.
- Add a short "alerting on watcher connectivity" note to `docs/metrics.md`
  recommending the metric-based alert over the log-based one, with the
  `increase(mailtool_watcher_reconnects_total[30m])` rule and an explicit
  warning that `connection_state` is too coarse to catch second-long drops
  between scrapes.

**Acceptance criteria:**
- Docs describe the thresholds, the backoff schedule, and which log level
  each situation produces.
