# syntax=docker/dockerfile:1

# Pinned to the current Active LTS major (not the floating `lts` tag) so a
# new Node major never lands in this image without a deliberate, reviewed
# Dockerfile change. Bumping this is the only step needed to move majors —
# both stages reference it from here.
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# tsc compiles src/, test/, and scripts/ together (see tsconfig.json's
# rootDir/include), so the real build output lives under dist/src rather
# than matching package.json's "main"/"start" path directly. Copying just
# dist/src back to ./dist restores that expected dist/server.js layout and
# drops the compiled test/scripts output, which the runtime image has no
# use for. This only works because the two modules that reach outside src/
# (mcp/server.ts, telemetry/instruments.ts, both importing ../../package.json)
# resolve that import relative to this stage's own /app/package.json above,
# not to the copy tsc placed at the original dist/package.json.
COPY --from=builder /app/dist/src ./dist

USER node
EXPOSE 3000 3001 9464

# otel-bootstrap.js is opt-in and deploy-time only (see docs/metrics.md) --
# it registers the Prometheus MeterProvider before src/server.ts loads, and
# is never referenced by npm start/dev or the test suite. Preloaded via
# --import rather than merged into server.ts so local dev/tests stay
# collection-free by default.
CMD ["node", "--import", "./dist/otel-bootstrap.js", "dist/server.js"]
