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
- **Flap window.** If a connection drops again within `W` of the previous
  successful reconnect (default ~5 minutes), the connection is flapping
  rather than healing. Escalate to `error` after `M` drops inside `W`. This
  is the "within a reasonable short time frame after another" condition from
  the request.
- **Recovery.** A reconnect that succeeds and survives `W` resets both
  counters and logs a single `info` recovery line naming the outage
  duration and attempt count — so an operator reading the log after the fact
  sees one tidy "dropped, back after 3s, 2 attempts" record instead of
  either silence or a stack trace.
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

`mailtool.watcher.reconnects` and `mailtool.watcher.connection.state`
already exist. Once the crash is fixed they become continuously meaningful
(today they reset on every crash). The recommendation is to alert on
`connection.state == 0` sustained over a few minutes, or on reconnect rate,
and to let the log-based alert group serve only the escalated `error` case.
Worth a short follow-up note in `docs/metrics.md`; the Grafana-side alert
rule change is out of scope for this repo.

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
- Add reconnect supervision: consecutive-failure counter, flap window,
  recovery reset; thresholds exposed via `AccountWatcherOptions`.
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
- Escalation fires on both the consecutive-failure and flap-window paths.
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
  recommending the metric-based alert over the log-based one.

**Acceptance criteria:**
- Docs describe the thresholds, the backoff schedule, and which log level
  each situation produces.
