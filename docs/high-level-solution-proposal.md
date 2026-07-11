## High-Level Solution Proposal

**Stack:** Fastify + TypeScript + `imapflow`, `zod` for config/schema validation, `@fastify/swagger` + `@fastify/swagger-ui` for docs, `vitest` for tests.

### Architecture

```
src/
  utils/
    config/        JSON config loading + zod schema validation (schema.ts, load.ts)
    logger.ts      createLogger(config) factory — pretty stdout locally/test, structured JSON (pluggable backend) otherwise
  imap/
    clientFactory.ts   creates short-lived imapflow connections for API requests
    watcher.ts          long-lived per-account IDLE connection, emits domain events
  services/
    mailboxService.ts   list folders, list/get messages, move, flag
  events/
    types.ts            NewMail / FlagsChanged / MailRemoved event shapes
    dispatcher.ts       Dispatcher interface + createDispatcher(config) factory
    dispatchers/
      webhookDispatcher.ts  HTTP webhook implementation (initial variant)
  api/
    routes/              one file per resource, fastify JSON schemas for OpenAPI
    plugin.ts            registers routes + swagger
  app.ts            builds fastify instance (routes + plugins), no listen()
  server.ts         entrypoint: loads config, starts watchers, calls app.listen()
```

**Key design decisions:**

- **Two connection types per account.** A persistent IDLE-watching connection (one per configured account, managed by `watcher.ts`), and a separate short-lived connection opened per API request via `clientFactory.ts`. This avoids concurrency issues between IDLE and on-demand commands and keeps each piece independently testable — no shared mutable connection state between the HTTP layer and the event layer.

- **Event detection via imapflow's native events**, mapped to your three cases:
  - *New mail* → `exists` event where `count > prevCount`.
  - *Flagged* → `flags` update event on a message.
  - *Moved mail* → best-effort via `expunge` events. Note: IMAP doesn't give a first-class "moved" notification — a MOVE looks like an expunge from the source client's perspective. True cross-folder move correlation (matching the expunged message to where it landed) is out of scope for v1; we'll emit `mailRemoved` on expunge and document this limitation rather than fake a guarantee we can't back up.

- **No persistence/caching** means: mailbox listings and message fetches always hit IMAP live per request; the watcher keeps only in-memory last-known counts per mailbox to detect deltas, reset on reconnect.

- **Config-driven accounts**: a JSON file defines `[{ id, host, port, secure, auth: { user, pass }, watchMailboxes: string[], dispatchers: [...] }]`, validated at startup with zod; invalid config fails fast with a clear error. Default location is `./config.json` at the project root, which is gitignored (it holds real credentials); the loader reads the path from a `CONFIG_PATH` env var when set, falling back to the default, so it can point elsewhere in other environments.

- **Pluggable event dispatchers**: `events/dispatcher.ts` defines a `Dispatcher` interface (`handle(event: DomainEvent): Promise<void>`) and a `createDispatcher(dispatcherConfig)` factory that switches on a `type` discriminator. `dispatchers/webhookDispatcher.ts` is the only implementation for v1 (`{ type: 'webhook', url }`). Each account's `dispatchers` array is a zod discriminated union on `type`; an account can have zero, one, or several dispatchers, and each `AccountWatcher`'s events fan out to all of them. Adding a new transport later (e.g. SQS, RabbitMQ) means adding a new `type` case to the schema and factory — the watcher and route layers stay untouched.

- **Configurable structured logging**: `utils/logger.ts` uses `pino` (Fastify's native logger) behind a single `createLogger(config)` factory — every module (watcher, dispatchers, client factory, routes) gets its logger via this factory or a `.child()` of the Fastify instance's logger, never `console.log`/a new `pino()` call directly. Locally and in tests, output is human-readable (`pino-pretty` transport) to stdout. In other environments the factory switches on a `LOG_TRANSPORT`/`LOG_BACKEND`-style config value to select a structured JSON transport — plain JSON-to-stdout by default, with room to add a Datadog (or other vendor) transport later as a new case in the same factory, without touching call sites.

- **Testability**: `imapflow` is mocked at the module boundary (`clientFactory` and `watcher` both take an injectable imapflow constructor), and Fastify routes are tested via `fastify.inject()` against mocked services — no real sockets or HTTP calls in unit tests.

---

## Task Breakdown

### Task 1 — Project scaffolding + CI + logging
**Status:** DONE
**Description:**
Set up TS project: `package.json`, `tsconfig.json`, ESLint/Prettier, `vitest` (or `jest`), build/dev scripts, `fastify` + `imapflow` + `zod` + `pino` (+ `pino-pretty` as a dev dep) deps installed. Add `.github/workflows/ci.yaml`: triggers on `pull_request` (`opened`, `synchronize`, `reopened`), runs install → lint → build → test on Node LTS. Add `utils/logger.ts`: a `createLogger(config)` factory wrapping `pino`, defaulting to a human-readable `pino-pretty` transport when `NODE_ENV` is `development`/`test`, and structured JSON to stdout otherwise; wire it as the Fastify instance's logger so route logs flow through the same factory.
**Acceptance criteria:** `npm run build` compiles with no errors; `npm test` runs and passes on a trivial placeholder test; `npm run dev` starts an empty Fastify server responding `200` on `GET /health`, logging human-readable lines to stdout; a unit test asserts `createLogger` produces structured JSON output when configured for a non-dev/test environment; opening a PR triggers the `ci.yaml` workflow and it passes on a clean checkout.
**Note:** wiring an actual vendor backend (e.g. Datadog) is left for a later task/config addition — Task 1 only needs the factory seam to exist. Marking the `ci.yaml` check as *required* for merge is a separate GitHub branch-protection setting (repo Settings → Branches), not a code change.

### Task 2 — Config schema + loader
**Status:** DONE
**Description:**
Implement `utils/config/schema.ts` (zod schema for account list, including a `dispatchers` array per account as a discriminated union on `type` — only `{ type: 'webhook', url }` defined for now) and `utils/config/load.ts` (resolves the config file path from the `CONFIG_PATH` env var, defaulting to `./config.json` at the project root when unset, reads and validates it, returns typed `AccountConfig[]`). Add `config.json` (and any `config*.json` local variants) to `.gitignore`, and commit a `config.example.json` showing the expected shape.
**Acceptance criteria:** Unit tests cover: valid config parses correctly; missing required field throws a descriptive error; duplicate account `id`s rejected; file-not-found throws a clear error; unknown `dispatchers[].type` rejected with a descriptive error; account with an empty `dispatchers` array is valid (no dispatch configured); loader reads from the default `./config.json` path when `CONFIG_PATH` is unset, and from the given path when `CONFIG_PATH` is set. No IMAP or HTTP dependency — pure function tests.

### Task 3 — IMAP client factory
**Status:** DONE
**Description:**
`imap/clientFactory.ts`: given an `AccountConfig`, returns a connected `ImapFlow` instance (opened, logged in), and a helper to safely close it. Constructor is injectable for testing.
**Acceptance criteria:** Unit tests mock `ImapFlow` and assert `connect()`/`logout()` are called with correct credentials; connection errors are caught and rethrown as a typed `ImapConnectionError`.

### Task 4 — Mailbox service (core IMAP operations)
**Status:** DONE
**Description:**
`services/mailboxService.ts` built on the client factory: `listMailboxes(accountId)`, `listMessages(accountId, mailbox, { limit, sinceUid })`, `getMessage(accountId, mailbox, uid)`, `moveMessage(...)`, `setFlags(...)`.
**Acceptance criteria:** Each method has unit tests against a mocked `ImapFlow` client verifying correct imapflow calls (`list`, `fetch`, `messageMove`, `messageFlagsAdd/Remove`) and correct return shape; connection is opened and closed per call.

### Task 5 — IDLE watcher / event emitter
**Status:** DONE
**Description:**
`imap/watcher.ts`: `AccountWatcher` class — one persistent connection per account, enters IDLE on configured mailboxes, tracks last-known message counts in memory, emits `newMail`, `flagsChanged`, `mailRemoved` events (typed, from `events/types.ts`). Includes basic reconnect-on-drop logic.
**Acceptance criteria:** Unit tests simulate `exists`/`flags`/`expunge` events on a mocked connection and assert the watcher emits the correct domain event with correct payload; simulated disconnect triggers a reconnect attempt (mocked).

### Task 6 — Event dispatcher framework + webhook dispatcher
**Status:** DONE
**Description:**
`events/dispatcher.ts`: `Dispatcher` interface (`handle(event: DomainEvent): Promise<void>`) plus `createDispatcher(dispatcherConfig)` factory that switches on `dispatcherConfig.type` and throws a descriptive error on an unrecognized type. A small wiring piece (e.g. in `server.ts` or a `dispatchers/index.ts`) subscribes each `AccountWatcher` to all `Dispatcher`s built from that account's `dispatchers` config array, and fans out every emitted event to each of them.
`events/dispatchers/webhookDispatcher.ts`: the first `Dispatcher` implementation — POSTs a JSON payload (`event`, `accountId`, `mailbox`, `data`, `timestamp`) to the configured URL. Basic retry (e.g. 1 retry on failure) and error logging, no persistence of failed deliveries.
**Acceptance criteria:** Unit tests for the factory: each supported `type` instantiates the matching implementation; an unrecognized `type` throws a descriptive error. Unit tests for `webhookDispatcher`: mock the HTTP client (e.g. `undici`/`fetch`), assert correct payload shape and URL per event type, and assert retry-once behavior on a simulated failure. One test registers a second, in-test stub `Dispatcher` type to prove the watcher/fan-out wiring is agnostic to dispatcher implementation (no changes needed outside the factory to add a type).

### Task 7 — App bootstrap & lifecycle
**Status:** DONE
**Description:**
`app.ts` builds the Fastify instance (routes + plugins) without binding a port, for testability. `server.ts` wires config → watchers → dispatcher → app → `listen()`, plus graceful shutdown (close IDLE connections, stop watchers on SIGINT/SIGTERM).
**Acceptance criteria:** `buildApp(config)` returns a working Fastify instance testable via `inject()` with no real network calls; shutdown handler closes all watcher connections (verified via mock).

### Task 8 — HTTP routes for IMAP operations
**Status:** DONE
**Description:**
Route files under `api/routes/`: mailboxes, messages (list/get), move, flags. Fastify JSON schemas defined per route for request/response (also feeds OpenAPI generation).
**Acceptance criteria:** Each route tested via `fastify.inject()` against a mocked `mailboxService`; covers happy path, 404 for unknown account/mailbox, 400 for invalid input.

### Task 9 — OpenAPI + docs page
**Status:** DONE
**Description:**
Register `@fastify/swagger` and `@fastify/swagger-ui`; ensure route schemas produce a coherent `openapi.json`.
**Acceptance criteria:** `GET /openapi.json` returns valid OpenAPI 3 document listing all routes; `GET /docs` serves the Swagger UI page; verified with a snapshot or schema-validation test.

### Task 10 — Error handling
**Status:** DONE
**Description:**
Central Fastify error handler producing a consistent error JSON shape (`{ error: { message, code } }`), mapping `ImapConnectionError` and validation errors to appropriate HTTP status codes.
**Acceptance criteria:** Unit tests trigger each error type through a route and assert status code + body shape.

### Task 11 — Integration test against a real IMAP server
**Status:** TODO
**Description:**
End-to-end integration test that exercises the stack against a **real IMAP server** — no IMAP mocking — using [GreenMail](https://greenmail-mail-test.github.io/greenmail/) (`greenmail/standalone` image, in-memory SMTP+IMAP) managed by [`testcontainers`](https://node.testcontainers.org/). The container is started per test run, its mapped IMAP/SMTP ports are read back (no fixed ports, no DNS/MX involved — everything is a direct `localhost:<mappedPort>` connection), and torn down after.

The test builds an `AccountConfig` pointing at the container, seeds a mailbox (via IMAP `APPEND` through a throwaway `imapflow` client, or SMTP submission to the container), then drives the real flow: boot `buildApp()` + start a real `AccountWatcher`, then `inject()` list mailboxes → list messages → get message → flag → move, asserting real IMAP results at each step. The watcher's real IDLE `exists`/`flags`/`expunge` events are wired to a webhook dispatcher whose URL points at a small in-test HTTP server that captures the POST; the test asserts the expected webhook payload is received (this is the part a mocked IMAP layer can never actually validate).

**Isolation from the unit suite (so it's easy to skip/disable):**
- Integration tests live under `test/integration/**` and are **excluded** from the default `vitest.config.ts` `include`/via `exclude`, so `npm test` never touches Docker.
- A dedicated `vitest.integration.config.ts` includes only `test/integration/**/*.test.ts` (longer `testTimeout`/`hookTimeout` for container startup).
- New scripts: `"test:integration": "vitest run --config vitest.integration.config.ts"` (and optionally `"test:all"` running both). Add `testcontainers` as a devDependency.
- CI runs it as a **separate, independently-disableable job** in `ci.yaml` (not a step in `checks`), e.g. `integration:` running `npm run test:integration`. GitHub-hosted `ubuntu-latest` runners have Docker available, so no extra service setup is needed. The job is guarded so it can be turned off in one line later if it becomes a burden (e.g. `if: vars.RUN_INTEGRATION != 'false'`, or a `workflow_dispatch`/label gate) — the fast `checks` job stays the required status check for merge.

**Acceptance criteria:** `npm test` (unit suite) runs with zero Docker/network dependency and never starts a container. `npm run test:integration` starts GreenMail, seeds mail, and passes the full list → get → flag → move flow plus the webhook-received assertion against the real server, then cleans up the container. The integration CI job passes on a clean checkout and can be disabled without touching the unit `checks` job.
**Note:** Keep the container image tag pinned (not `:latest`) for reproducibility. If GreenMail's feature set ever proves limiting, `docker-mailserver` (real Postfix/Dovecot) is a heavier drop-in alternative behind the same testcontainers seam.

### Task 12 — README / docs
**Status:** TODO
**Description:**
Document config file format, how to run, endpoint list, webhook payload shapes, and the known limitation on "moved mail" detection.
**Acceptance criteria:** A new developer can configure one test account and run the server using only the README.

---

Each task depends only on the interfaces defined by the previous ones (not their internals), so they can be built and reviewed independently, and mocked at their boundary for the tasks that consume them. Want me to start scaffolding Task 1, or flesh out the zod config schema first?