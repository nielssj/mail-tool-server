# syntax=docker/dockerfile:1

FROM node:lts-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:lts-alpine AS runtime
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
EXPOSE 3000 3001

CMD ["node", "dist/server.js"]
