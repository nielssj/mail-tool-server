## `newMail` Event UID — Solution Proposal

**Goal:** Extend the `newMail` domain event's `data` payload with the UID(s)
of the message(s) that just arrived, so a webhook consumer can act on the
specific new message(s) directly instead of having to poll `list_messages`
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

**Out of scope for this proposal:**
- Any change to `flagsChanged`/`mailRemoved` — both already carry `uid`.
- A new MCP tool or HTTP route. This is purely an event-payload enrichment.
- `webhookDispatcher.ts` — it serializes the whole `DomainEvent` as JSON
  already (`src/events/dispatchers/webhookDispatcher.ts:29`), so a new
  optional `data` field needs zero changes there.
- Backfilling UIDs for events that would have fired before this ships.
- Deduplicating/correlating UIDs across reconnects beyond what's described
  below (e.g. no persistence of watermarks across process restarts — see
  "Open questions").

### Current behavior

`AccountWatcher.handleExists` (`src/imap/watcher.ts:314-338`) compares the
new `EXISTS` count to a per-mailbox count it tracks in memory
(`mailboxCounts`), and emits `newMail` with `{ count, previousCount }` when
the count rose. It never looks at *which* messages are new.

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
time it's opened to `uidNext - 1` (the highest UID that could already exist).
If the mailbox was already known and `uidValidity` has changed since the
last open, reset the watermark the same way rather than trusting the old
value — a `UIDVALIDITY` change means previously-seen UIDs are no longer
meaningful (rare, but real: e.g. a server-side mailbox rebuild).

**2. On `handleExists`, when `count > previousCount`, fetch the UIDs of just
the new range.**

`client.fetch(\`${watermark + 1}:*\`, { uid: true }, { uid: true })` — same
shape as `mailboxService.ts`'s existing `sinceUid` fetch, scoped to UIDs
only (no envelope/flags/body — this is an enrichment fetch, not a full
message read, so it should stay as cheap as possible). This requires adding
a `fetch` method to the `WatcherClient` interface, which today only exposes
`connect`/`logout`/`mailboxOpen`/`idle`/`on`/`off`.

Sort the returned UIDs ascending, attach them to the event, and advance the
watermark to the highest UID actually seen — not to `count`-derived math —
so a partial/failed fetch never silently skips a UID range.

**3. The real risk: this fetch fires *during* an active IDLE, and IDLE and
FETCH share one connection.**

Today, `beginIdle()` holds a single `client.idle()` promise per mailbox and
only proceeds (to round-robin to the next `watchMailboxes` entry, or
re-idle) once that promise resolves. Reading imapflow's own source
(`node_modules/imapflow/lib/commands/idle.js:15-43`,
`node_modules/imapflow/lib/imap-flow.js:3709-3721`): any other command run
on the same connection — including our enrichment `fetch()` — triggers
`preCheck()`, which sends `DONE` to break IDLE *before* running the new
command. That `DONE` is what resolves the pending `client.idle()` promise in
`beginIdle()`.

Concretely: if `handleExists` fires the enrichment `fetch()` without
coordinating with `beginIdle()`, the `client.idle()` promise in
`beginIdle()` can resolve (because IDLE broke) essentially concurrently with
our own `fetch()` still being in flight. For a single-mailbox account this
is harmless (there's nowhere else for `beginIdle()` to go but back into
IDLE on the same mailbox). For an account watching **multiple** mailboxes in
round-robin, `beginIdle()`'s continuation calls `openActiveMailbox()` —
another command (`SELECT`/`EXAMINE` for the *next* mailbox) — on the same
connection our enrichment fetch is still using. Both are real, serialized
IMAP commands (imapflow's per-connection mailbox lock queue prevents actual
protocol corruption), but the *order* they run in is not something this
proposal should leave implicit — getting it wrong risks the enrichment
fetch running against the wrong selected mailbox, or the next mailbox's
`IDLE` starting later than expected.

**Mitigation, not just a caveat:** make `handleExists` async and have it
return the in-flight enrichment promise; have `beginIdle()`'s `.then()`
continuation explicitly await that promise (tracked as e.g.
`this.pendingEnrichment`) before calling `openActiveMailbox()`/re-idling.
This turns an implicit race into an explicit, intentional sequencing point:
finish enriching the mailbox we just got new mail in before moving on. Note
this doesn't introduce a fundamentally new gap — there's already a brief
window with no active IDLE while round-robin switches mailboxes today; this
extends that existing, already-accepted gap by however long one UID-only
fetch takes, rather than introducing a new category of risk. A message that
arrives during that window is still caught by the next `mailboxOpen`'s
count comparison, same as today.

**4. Graceful degradation.** If the enrichment fetch throws (transient IMAP
error, connection drop mid-fetch), log via the existing `WatcherLogger` and
still emit `newMail` with `count`/`previousCount` as today, just without
`uids` — never let enrichment failure suppress or crash the core event.
Consumers that only care about `count`/`previousCount` see no behavior
change at all.

**5. Event shape.**

```ts
export type NewMailEvent = {
  event: 'newMail';
  accountId: string;
  mailbox: string;
  data: {
    count: number;
    previousCount: number;
    /** UIDs of the newly-arrived messages, ascending. Omitted (not empty)
     * when the enrichment fetch failed — distinguishes "unknown" from
     * "zero new messages" (which can't happen; this event only fires when
     * count > previousCount). Not guaranteed to have exactly
     * `count - previousCount` entries in every edge case (e.g. a message
     * that arrived and was expunged again before the fetch ran) — treat
     * `count`/`previousCount` as authoritative for "how many", `uids` as
     * best-effort enrichment for "which ones". */
    uids?: number[];
  };
  timestamp: string;
};
```

Purely additive — `count`/`previousCount` are untouched, so this is a
non-breaking change for any existing webhook consumer.

### Alternatives considered

- **Emit one `newMail` event per new message (singular `uid`), matching
  `flagsChanged`/`mailRemoved`'s shape.** Rejected: multiplies event/webhook
  volume for bulk imports (a 200-message backfill becomes 200 webhook POSTs
  instead of 1), and breaks the existing `count`/`previousCount` batch
  semantics that current consumers may already depend on. A consumer that
  wants one-event-per-message can trivially fan the array out itself.
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

### Task Breakdown

#### Task 1 — Watcher UID enrichment
**Status:** Not started
**Description:**
- Widen `MailboxOpenResult`/`WatcherClient` (`src/imap/watcher.ts`) to
  surface `uidNext`/`uidValidity` from `mailboxOpen`, and add a `fetch`
  method to `WatcherClient` for the UID-only enrichment query.
- Add `mailboxUidWatermarks`/`mailboxUidValidity` maps; initialize/reset per
  the `uidValidity`-change rule above.
- Make `handleExists` async; perform the enrichment fetch and attach
  `data.uids`; make `beginIdle()`'s continuation await it before
  round-robining to the next mailbox (the sequencing fix described above).
- Add `uids?: number[]` to `NewMailEvent` in `src/events/types.ts`.
- Update `README.md`'s event table/example payload and the "Known
  limitation" area if relevant.
- Extend `MockWatcherClient` in `test/watcher.test.ts` with a `fetch`
  method.

**Acceptance criteria:**
- Unit tests (mocked `WatcherClient`, no live IMAP server — see "Open
  questions" below on what this does and doesn't prove): a single new
  message produces `data.uids` with exactly that UID; several messages
  arriving in one `EXISTS` jump produce all their UIDs, ascending; a
  simulated enrichment-fetch failure still emits `newMail` with `count`/
  `previousCount` and no `uids`, plus a logged warning, and does not throw
  out of the watcher; a `uidValidity` change between two opens of the same
  mailbox resets the watermark instead of computing a bogus range; for a
  multi-mailbox account, `openActiveMailbox()` for mailbox B is not called
  until mailbox A's in-flight enrichment fetch has settled (this is the
  test that actually exercises the sequencing fix, not just the happy
  path).
- `npm run lint`, `npx tsc -p tsconfig.json --noEmit`, `npm test` all green.
- Existing `newMail`-related tests (count/previousCount behavior,
  reconnect/round-robin tests) pass unmodified in their assertions about
  `count`/`previousCount` — only new assertions are added.

### Open questions

1. **This can only be verified against a mock in this sandbox.** The
   IDLE-break-then-FETCH ordering described above is a real behavior of the
   `imapflow` library talking to a real IMAP server; a mocked
   `WatcherClient` can assert *this codebase's* sequencing (that we await
   enrichment before round-robining) but can't prove imapflow itself
   behaves the way its source suggests once TLS/network timing is real. As
   with the Docker build check added earlier, recommend a manual smoke test
   against a real (or a real open-source IMAP test server, e.g. Dovecot in
   CI) mailbox with `watchMailboxes` set to two or more folders before
   trusting this in production — happy to add that as CI coverage similar
   to the `docker-build` job if that's wanted, but flagging it as a
   follow-up rather than folding it into Task 1 by default.
2. **Is a single task the right size, or should the sequencing fix
   (Task 1, point 3 above) be split out from the UID-fetch itself?** They're
   tightly coupled — the fetch isn't safe to add without the sequencing fix
   — so this proposal defaults to one task/one PR, but flagging in case a
   smaller reviewable diff is preferred.
3. **Any interest in also capping how many UIDs get inlined into one event**
   (e.g. a mailbox that receives a 5,000-message bulk import in one
   `EXISTS` jump)? Current proposal has no cap — `uids` grows with however
   many messages arrived. Could add a cap (e.g. first N, with `count` still
   reflecting the true total) if unbounded array size in a webhook payload
   is a concern.
