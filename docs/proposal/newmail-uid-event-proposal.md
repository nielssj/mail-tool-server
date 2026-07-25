## `newMail` Event UID — Solution Proposal

**Goal:** Change the `newMail` domain event to fire once per newly-arrived
message, carrying that message's UID, so a webhook consumer can act on a
specific new message directly instead of having to poll `list_messages`
(or `mailboxService.listMessages`) and diff against its own client-side
watermark just to find out what changed.

**Feasibility: yes, with one real design risk to handle carefully (see
below).** IMAP's `EXISTS` untagged response — the thing that already drives
`handleExists` in `src/imap/watcher.ts` — only ever reports a new total
message count, never UIDs. Getting UIDs requires a second round-trip: a
`FETCH` for the UIDs of the messages between the old and new count. This is
exactly the operation `mailboxService.listMessages`'s `sinceUid` option
already performs (`src/services/mailboxService.ts:339-340`,
`client.fetchAll(range, query, { uid: true })`), so the primitive is proven
in this codebase — the new part is triggering it from inside the watcher's
live IDLE loop rather than from a caller-initiated request, which has a
sequencing hazard that request-driven code never has to deal with.

**This is a breaking change to the event schema**, per explicit steer:
`newMail` moves from one batched event per `EXISTS` jump (`count`,
`previousCount`) to one event per message (`uid`, `count`).
`previousCount` is dropped; `count` is kept.

**Out of scope for this proposal:**
- Any change to `flagsChanged`/`mailRemoved` — both already carry `uid` and
  already fire once per message.
- A new MCP tool or HTTP route. This is purely an event-payload/emission
  change.
- `webhookDispatcher.ts` — it serializes whatever `DomainEvent` it's handed
  as JSON already (`src/events/dispatchers/webhookDispatcher.ts:29`); it has
  no opinion on how many events fire per `EXISTS` jump, so it needs zero
  changes.
- Backfilling UIDs/re-emitting for mail that arrived before this ships.
- Capping burst size (e.g. a 5,000-message bulk import producing 5,000
  events) — raised and explicitly dropped as not relevant for this pass.

### Current behavior

`AccountWatcher.handleExists` (`src/imap/watcher.ts:314-338`) compares the
new `EXISTS` count to a per-mailbox count it tracks in memory
(`mailboxCounts`), and emits one `newMail` event with `{ count,
previousCount }` when the count rose — regardless of how many messages
arrived in that jump.

### Design

**1. Track a per-mailbox UID watermark, not just a count.**

`ImapFlow#mailboxOpen` already returns `uidNext` and `uidValidity` on the
real client (`node_modules/imapflow/lib/imap-flow.d.ts:117-119`) — the
`WatcherClient`/`MailboxOpenResult` types in `watcher.ts` currently narrow
this down to `{ exists?: number }` and drop both. Widen `MailboxOpenResult`
to also carry `uidNext?: number` and `uidValidity?: bigint`, and add a
`mailboxUidWatermarks: Map<string, number>` (and a
`mailboxUidValidity: Map<string, bigint>`) alongside the existing
`mailboxCounts`.

On `openActiveMailbox()`, initialize the watermark for a mailbox the first
time it's opened to `uidNext - 1` (the highest UID that could already
exist). If the mailbox was already known and `uidValidity` has changed
since the last open, reset the watermark the same way rather than trusting
the old value — a `UIDVALIDITY` change means previously-seen UIDs are no
longer meaningful (rare, but real: e.g. a server-side mailbox rebuild).

**2. On `handleExists`, when `count > previousCount`, fetch the UIDs of just
the new range, with a bounded retry.**

`client.fetch(\`${watermark + 1}:*\`, { uid: true }, { uid: true })` — same
shape as `mailboxService.ts`'s existing `sinceUid` fetch, scoped to UIDs
only (no envelope/flags/body — this is an enrichment fetch, not a full
message read, so it should stay as cheap as possible). This requires adding
a `fetch` method to the `WatcherClient` interface, which today only exposes
`connect`/`logout`/`mailboxOpen`/`idle`/`on`/`off`.

Retry once on failure (2 attempts total), mirroring
`webhookDispatcher.ts`'s existing `MAX_ATTEMPTS = 2` convention
(`src/events/dispatchers/webhookDispatcher.ts:5`) rather than inventing a
new retry policy. If it still fails, log via the existing `WatcherLogger`
and emit nothing for this cycle — see point 4 below for why that's the
right degraded behavior now.

Sort the returned UIDs ascending, emit one event per UID (point 5), and
advance the watermark to the highest UID actually seen — not to
`count`-derived math — so a partial/failed fetch never silently skips a UID
range.

**3. The real risk: this fetch fires *during* an active IDLE, and IDLE and
FETCH share one connection.**

Today, `beginIdle()` holds a single `client.idle()` promise per mailbox and
only proceeds (to round-robin to the next `watchMailboxes` entry, or
re-idle) once that promise resolves. Reading imapflow's own source
(`node_modules/imapflow/lib/commands/idle.js:15-43`,
`node_modules/imapflow/lib/imap-flow.js:3709-3721`): any other command run
on the same connection — including our enrichment `fetch()` — triggers
`preCheck()`, which sends `DONE` to break IDLE *before* running the new
command. That `DONE` is what resolves the pending `client.idle()` promise
in `beginIdle()`.

Concretely: if `handleExists` fires the enrichment `fetch()` without
coordinating with `beginIdle()`, the `client.idle()` promise in
`beginIdle()` can resolve (because IDLE broke) essentially concurrently
with our own `fetch()` still being in flight. For a single-mailbox account
this is harmless (there's nowhere else for `beginIdle()` to go but back
into IDLE on the same mailbox). For an account watching **multiple**
mailboxes in round-robin, `beginIdle()`'s continuation calls
`openActiveMailbox()` — another command (`SELECT`/`EXAMINE` for the *next*
mailbox) — on the same connection our enrichment fetch is still using. Both
are real, serialized IMAP commands (imapflow's per-connection mailbox lock
queue prevents actual protocol corruption), but the *order* they run in is
not something this proposal should leave implicit.

**Mitigation:** make `handleExists` async and have it return the in-flight
enrichment promise; have `beginIdle()`'s `.then()` continuation explicitly
await that promise (tracked as e.g. `this.pendingEnrichment`) before
calling `openActiveMailbox()`/re-idling. This turns an implicit race into
an explicit, intentional sequencing point: finish enriching (and emitting
for) the mailbox we just got new mail in before moving on. This doesn't
introduce a fundamentally new gap — there's already a brief window with no
active IDLE while round-robin switches mailboxes today; this extends that
existing, already-accepted gap by however long one UID-only fetch (plus its
possible one retry) takes. A message that arrives during that window is
still caught by the next `mailboxOpen`'s count comparison, same as today.

This is validated empirically, not just reasoned about from source — see
"Verification" below.

**4. Graceful degradation looks different now that `uid` is mandatory.**

The previous draft of this proposal (batched `count`/`previousCount` event,
optional `uids`) could always fall back to a data-light, count-only event
if enrichment failed. Once every event *is* a single message's UID, there's
no meaningful degraded form of the event itself — an event with no `uid`
isn't a `newMail` notification. So on a fetch that still fails after its
retry: log an error, advance nothing, emit nothing for this cycle. The
watermark stays where it was, so the missed UID range is naturally picked
up whenever a later `EXISTS` jump triggers a successful fetch — no
permanent data loss, but notification can be delayed if the mailbox goes
quiet after a failure. This delayed-catch-up trade-off is the direct,
accepted cost of moving to a uid-required, per-message event; it's called
out explicitly rather than left implicit.

**5. Emission model: one event per UID, in ascending order, same `count` on
each.**

```ts
export type NewMailEvent = {
  event: 'newMail';
  accountId: string;
  mailbox: string;
  data: {
    uid: number;
    /** Mailbox's total message count as of this EXISTS jump — the one
     * number IMAP actually told us. The same value is repeated on every
     * event emitted from a single jump (e.g. 3 messages arriving at once,
     * taking the mailbox from 5 to 8, all three events carry count: 8).
     * Deliberately not synthesized into a running per-message total
     * (6, 7, 8) — IMAP never told us the count grew message-by-message in
     * that order, only that it jumped by 3 atomically. */
    count: number;
  };
  timestamp: string;
};
```

`previousCount` is dropped entirely, per steer. This is a breaking schema
change — see "Release/versioning" below.

**6. Release/versioning.** This repo's `release-drafter` config already maps
a `breaking-change` label to a major version bump
(`.github/release-drafter.yml`). The implementing PR should carry that
label so the resulting Docker image release reflects this correctly —
using the mechanism already built for exactly this, not inventing a new
process.

### Ripple effects (files touched beyond the obvious)

- **`src/telemetry/watcherMetrics.ts`** — `watcherNewMailMessages.add(event.data.count
  - event.data.previousCount, ...)` no longer compiles once `previousCount`
  is gone, and no longer needs to: with one event per message, it becomes
  `.add(1, ...)` per event — simpler, and no longer a derived delta.
- **`test/watcherMetrics.test.ts`** — update assertions built on the old
  batched delta.
- **`test/watcher.test.ts`** — update `previousCount`-based assertions;
  extend `MockWatcherClient` with a `fetch` method; add the new sequencing/
  retry/degradation test cases (see Task 1 below).
- **`test/integration/mailFlow.test.ts`** — its existing webhook assertion
  (`expect(event.data.count).toBeGreaterThan(event.data.previousCount)`, line
  ~292) no longer compiles under the new schema; becomes the base for the
  new real-server scenarios below rather than being deleted outright.
- **`README.md`** — event table + example payload.

### Alternatives considered

- **Batched single event with `uids: number[]` plus `count`/`previousCount`**
  (this proposal's prior draft) — superseded per steer toward one event per
  message. Would have multiplied nothing (still 1 webhook POST per `EXISTS`
  jump regardless of burst size) at the cost of every consumer having to
  unpack an array; the per-message model is simpler for the common
  single-message-at-a-time case this server mostly sees, at the cost of N
  webhook POSTs for a genuine bulk import. Accepted per steer.
- **Derive the new range from sequence numbers (`${previousCount + 1}:*`)
  instead of a tracked UID watermark.** Simpler — no extra state, no
  `uidValidity` handling — but sequence numbers are only valid as of the
  last known mailbox state and shift under concurrent `EXPUNGE`. A UID
  watermark is stable by construction (UIDs are never reused within a
  `UIDVALIDITY` epoch), so it's the correct primitive even though it's a
  bit more bookkeeping.
- **`UID SEARCH RECENT`/`UNSEEN` instead of a watermark.** Rejected: `\Recent`
  is a legacy, unreliable, single-session flag many servers implement
  inconsistently; `\Unseen` would also match older already-reported unread
  mail, not just what's new since the watermark.

### Verification

This repo already has a real IMAP integration suite
(`test/integration/mailFlow.test.ts`, GreenMail via testcontainers,
`npm run test:integration`) that drives a real `AccountWatcher` against a
real IMAP server with real IDLE and a real webhook receiver. That's exactly
what's needed to validate the IDLE-break/FETCH sequencing risk empirically,
instead of only trusting a mocked `WatcherClient` or imapflow's source
comments — extending it, rather than relying on mocked-only coverage, is
part of Task 1's acceptance criteria, not a follow-up:

1. **Burst of multiple messages in one `EXISTS` jump.** Append 3 messages
   back-to-back (via a throwaway `ImapFlow` client, same pattern as the
   existing `appender` in `mailFlow.test.ts`) before the watcher's IDLE
   cycle has a chance to notice them individually. Assert exactly 3
   `newMail` webhook events arrive, each with a real, distinct, correct
   `uid` (cross-checked against a direct `list_messages` call) and the same
   correct `count`.
2. **Multi-mailbox round-robin sequencing.** A dedicated scenario using
   `watchMailboxes: ['INBOX', 'Archive']`: append a message to INBOX, then
   immediately append a message to Archive while INBOX's enrichment fetch
   is plausibly still in flight. Assert both mailboxes' events arrive with
   correct `mailbox`/`uid` attribution and that no event's mailbox/uid
   pairing is scrambled — this is the actual empirical test of the
   sequencing fix in point 3 above, something a mock can't prove.
3. **Retry/degradation** stays a mocked-`WatcherClient` unit test (forcing a
   transient then-successful fetch, and a persistently-failing fetch) —
   GreenMail has no supported way to inject a transient `FETCH` failure on
   demand, so this part of the design is verified at the unit level, not
   the integration level.

### Task Breakdown

#### Task 1 — Watcher UID enrichment + per-message emission
**Status:** Not started
**Description:**
- Widen `MailboxOpenResult`/`WatcherClient` (`src/imap/watcher.ts`) to
  surface `uidNext`/`uidValidity` from `mailboxOpen`, and add a `fetch`
  method to `WatcherClient` for the UID-only enrichment query.
- Add `mailboxUidWatermarks`/`mailboxUidValidity` maps; initialize/reset per
  the `uidValidity`-change rule above.
- Make `handleExists` async; perform the enrichment fetch (2 attempts) and,
  on success, emit one `newMail` event per UID (ascending); make
  `beginIdle()`'s continuation await the in-flight enrichment before
  round-robining to the next mailbox (the sequencing fix above).
- Replace `NewMailEvent`'s `{ count, previousCount }` with `{ uid, count }`
  in `src/events/types.ts`.
- Update `src/telemetry/watcherMetrics.ts`'s `watcherNewMailMessages` to
  `.add(1, ...)` per event.
- Update `README.md`'s event table/example payload.
- Update `test/watcher.test.ts`, `test/watcherMetrics.test.ts` for the new
  schema; extend `MockWatcherClient` with `fetch`.
- Extend `test/integration/mailFlow.test.ts` with the two GreenMail
  scenarios described above (burst + multi-mailbox sequencing), replacing
  its now-invalid `previousCount` assertion.
- Open the implementing PR with the `breaking-change` label.

**Acceptance criteria:**
- Unit tests (mocked `WatcherClient`): several messages arriving in one
  `EXISTS` jump produce one event per UID, ascending, each with the correct
  (same) `count`; a transient enrichment-fetch failure that succeeds on
  retry still emits correctly; a persistently-failing fetch emits nothing
  for that cycle, logs a warning, and leaves the watermark unadvanced so a
  later successful fetch picks up the missed range; a `uidValidity` change
  between two opens of the same mailbox resets the watermark instead of
  computing a bogus range; for a multi-mailbox account, `openActiveMailbox()`
  for mailbox B is not called until mailbox A's in-flight enrichment fetch
  has settled.
- Integration tests (GreenMail, real server): both new scenarios in
  "Verification" above pass against a real IMAP server with real IDLE.
- `npm run lint`, `npx tsc -p tsconfig.json --noEmit`, `npm test`,
  `npm run test:integration` all green.

### Resolved decisions

1. **One `newMail` event per new message**, not one batched event per
   `EXISTS` jump — breaking change, `previousCount` dropped, `count` kept
   (mailbox total as observed in that `EXISTS` jump, repeated across every
   event from the same jump — never synthesized into a fake running total).
2. **Single task, single PR** for the whole change.
3. **No cap on burst size** — out of scope for this pass, raised and
   explicitly dropped.
4. **Verified for real against the existing GreenMail integration suite**,
   not just mocks — closing the prior draft's biggest open gap.
