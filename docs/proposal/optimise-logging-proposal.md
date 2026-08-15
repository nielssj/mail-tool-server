## Optimise Logging — Plan

**Problem:** Grafana ingested >4k log lines over ~3 hours while the server
was idle. The top 20 by volume are Fastify's built-in access logs for
`GET /health` (the liveness/uptime-probe endpoint gets hit far more often
than any real traffic). Separately, even though logs are structured JSON and
parse cleanly in Grafana, the `level` field is pino's numeric level
(`30`, `50`, ...) rather than a textual one (`info`, `error`, ...), so
Grafana's log-level detection doesn't pick it up without a custom parser
rule.

Two independent fixes:

### 1. Toggleable access logs

**Root cause:** Fastify auto-logs every request via its built-in
`onRequest`/`onResponse` hooks whenever a `logger`/`loggerInstance` is
configured (`src/app.ts:17-19`) — there's no separate switch for this today;
it's tied to the logger being present at all.

**Fix:** Use Fastify's own `disableRequestLogging` option, wired to a new
env var, independent of `LOG_LEVEL`:

- New env var `ACCESS_LOG_ENABLED` (default `true`, matches the existing
  `HTTP_ENABLED`/`MCP_ENABLED` boolean convention — `!== 'false'`).
- `BuildAppOptions` gains `accessLogEnabled?: boolean` (default `true`),
  passed to `Fastify({ disableRequestLogging: !accessLogEnabled, ... })`.
- `server.ts` reads `process.env.ACCESS_LOG_ENABLED` and passes it into
  `buildApp`, the same way `HTTP_ENABLED`/`MCP_ENABLED` are read today.

This is a single global toggle, not a per-route one — it's what was asked
for (you may want `DEBUG`/`INFO` app logs without access-log noise, or vice
versa). It fully answers the stated need, so it's the only mechanism this
plan proposes; noted here for completeness but *not* part of this change:
Fastify also supports silencing individual routes via a route-level
`config: { logLevel: 'silent' }` (e.g. just for `/health`), which would be
an easy follow-up if a partial mute is ever wanted instead of an all-or-
nothing switch.

### 2. Textual log levels

**Root cause:** pino defaults to numeric levels in its output
(`src/utils/logger.ts` sets no `formatters` option). This is a pino config
knob, not a Grafana-side parsing gap: pino supports a `formatters.level`
hook that replaces the numeric level with the level's label string in every
log line.

**Fix:** in `createLogger` (`src/utils/logger.ts`), add:

```ts
formatters: {
  level: (label) => ({ level: label })
}
```

Confirmed compatible with the existing `pino-pretty` dev/test transport:
pino only rejects a custom `formatters.level` when `transport.targets`
(the multi-target array form) is used — this repo's transport is the
single-target form (`transport: { target: 'pino-pretty', ... }`), which pino
explicitly allows to run through the level formatter (verified against
`node_modules/pino/lib/tools.js`). No transport changes needed.

Net effect: `{"level":30,...}` becomes `{"level":"info",...}` in production
JSON output — no custom Grafana/Loki parser rule required, and consistent
with `pino-pretty`'s dev-mode output, which already renders the label.

### Test/doc updates

- `test/logger.test.ts`: update the existing assertion from
  `level: 30` to `level: 'info'`.
- New test in `test/health.test.ts` (or a new `test/accessLog.test.ts`):
  build the app with `accessLogEnabled: false`, inject a request, assert no
  request/response log lines were written to the logger's destination
  (mirrors the `PassThrough`-destination pattern already used in
  `test/logger.test.ts`).
- `README.md` env var table: add `ACCESS_LOG_ENABLED` row; update the
  `LOG_LEVEL` row's description to mention the level is now textual.

### Explicitly out of scope

- Reducing health-check *frequency* (that's the prober's config, outside
  this repo).
- Any change to what gets logged at each level, or to the metrics exporter
  added in the previous change — this is only the two items above.
