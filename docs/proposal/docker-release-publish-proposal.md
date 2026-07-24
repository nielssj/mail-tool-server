## Docker Image Publish + Release Drafter — High-Level Plan

**Goal:** On every merge to `main`, automatically compute the next semantic
version from merged-PR labels (via
[`release-drafter`](https://github.com/release-drafter/release-drafter)),
publish a GitHub Release for that version, and build + push a Docker image
for the server to the GitHub Container Registry (GHCR), tagged with that
version (and `latest`). The release itself carries **no file artifacts** — the
container image *is* the release artifact; the GitHub Release just records
the version and changelog that image corresponds to.

**Explicitly out of scope for this proposal:**
- Any registry other than GHCR (Docker Hub, ECR, etc.).
- Deploying the image anywhere. This proposal only builds and publishes it.
- Multi-arch images (`linux/amd64` only for v1) — noted as a possible
  follow-up.
- Changes to the existing `ci.yaml` PR-check workflow — this is a new,
  separate workflow, triggered differently (`push` to `main`, not `pull_request`).
- Bumping `package.json`'s `version` field — see design decision below.

### Stack additions

No new npm dependencies. New tooling, all GitHub Actions (no runtime
dependency on the built image or the app itself):
- `release-drafter/release-drafter` — drafts/publishes the GitHub Release and
  resolves the next semver version from PR labels.
- `docker/login-action`, `docker/build-push-action` — official Docker actions
  for authenticating to GHCR and building/pushing the image.
- A new `Dockerfile` and `.dockerignore` in the repo root.

### How versioning works (release-drafter)

`release-drafter` reads merged PRs since the last release, buckets them into
changelog categories by label, and resolves the next version by looking for
the *highest-impact* semver label across those PRs (major > minor > patch),
falling back to a configured default bump if none match. It can run in two
modes controlled by its `publish` input:
- `publish: false` (default) — creates/updates a **draft** release with the
  computed name/tag/body, but does not make it public. Safe to run
  repeatedly; it just keeps overwriting the same draft.
- `publish: true` — publishes that release immediately (or converts an
  existing matching draft into a published release).

This repo currently only has GitHub's default label set (`bug`,
`documentation`, `duplicate`, `enhancement`, `good first issue`,
`help wanted`, `invalid`, `question`, `wontfix`) — no major/minor/patch
concept exists yet. To avoid inventing an all-new labeling scheme,
`.github/release-drafter.yml` reuses the existing labels where their meaning
already lines up, and adds exactly **one** new label:

| Label (existing unless noted) | Version bump | Changelog category |
| --- | --- | --- |
| `breaking-change` **(new)** | major | Breaking Changes |
| `enhancement` | minor | Features |
| `bug` | patch | Bug Fixes |
| `documentation` | none (patch fallback) | Documentation |
| everything else / unlabeled | patch (default) | Maintenance |

### Architecture

```
.github/
  release-drafter.yml         Config: categories, version-resolver
                               (major/minor/patch label mapping above),
                               tag-template "v$RESOLVED_VERSION",
                               name-template "v$RESOLVED_VERSION", and a
                               body template that includes a
                               `docker pull ghcr.io/nielssj/mail-tool-server:v$RESOLVED_VERSION`
                               line for discoverability.
  workflows/
    release.yaml               New workflow. Trigger: `push` to `main`
                               (i.e. every merge). Three sequential jobs,
                               described below.
Dockerfile                     Multi-stage: `builder` (node:lts-alpine,
                               `npm ci`, `npm run build`) -> runtime
                               (node:lts-alpine, `npm ci --omit=dev`,
                               copies `dist/` from builder, runs as the
                               image's existing non-root `node` user).
                               `EXPOSE 3000 3001` (matching `PORT`/
                               `MCP_PORT` defaults in `src/server.ts`).
                               `CMD ["node", "dist/server.js"]`. No
                               `config.json` baked in — the runtime config
                               (`CONFIG_PATH` env var, per
                               `src/utils/config/load.ts`) is expected to
                               be mounted at deploy time, same as today.
.dockerignore                  `node_modules`, `.git`, `test/`, `docs/`,
                               `config.json`, `*.log`, etc.
```

`release.yaml` jobs, in order:

1. **`draft-release`** — runs `release-drafter/release-drafter@v6` with
   `publish: false` against `.github/release-drafter.yml`. Outputs
   `tag_name` (e.g. `v1.4.0`), used by both later jobs. This both keeps a
   live, always-current draft of "what the next release will look like"
   visible on GitHub at all times, and tells the pipeline what version this
   run is building — without making anything public yet.
2. **`build-and-push`** (`needs: draft-release`) — logs into `ghcr.io` via
   `docker/login-action` using the built-in `GITHUB_TOKEN`, then builds the
   image from the new `Dockerfile` and pushes it via
   `docker/build-push-action`, tagged
   `ghcr.io/nielssj/mail-tool-server:${{ needs.draft-release.outputs.tag_name }}`
   and `ghcr.io/nielssj/mail-tool-server:latest`.
3. **`publish-release`** (`needs: build-and-push`) — re-runs
   `release-drafter/release-drafter@v6`, same config, with `publish: true`.
   Because this job only runs after `build-and-push` succeeds, a published
   release always has a matching image already sitting in GHCR — never a
   public release pointing at an image that failed to build.

No step uploads files to the release (no `actions/upload-release-asset`,
no `softprops/action-gh-release` asset globs) — `release-drafter` alone
never attaches artifacts by default, so "no artifacts, just representing the
image" falls out of the design for free; the `docker pull ...` line in the
body template is the only pointer from the release to the image.

### Key design decisions

- **Draft-then-build-then-publish, not build-then-draft-then-publish.** The
  version number has to exist before the image can be tagged with it, so
  `release-drafter` must run in draft mode first purely to *resolve* the
  version — but publishing the release before the image push is confirmed
  successful would leave a public release with no corresponding image if the
  Docker build failed. Running `publish: true` as the last job, gated on
  `build-and-push` succeeding, avoids that failure mode entirely at the cost
  of one extra (cheap) `release-drafter` invocation per run.
- **`package.json`'s `version` field is left untouched (stays `"1.0.0"`) and
  is never treated as a source of truth.** The package is `"private": true`
  with no npm-registry target today, so nothing reads that field; keeping it
  static avoids a workflow step that commits a version bump back to `main`
  (which would itself need to avoid re-triggering the same workflow in a
  loop). `release-drafter`'s resolved tag is the *only* version authority —
  both for the release and the image tag. If this package is ever published
  to npm, the recommended pattern is to override the on-disk version at
  publish time rather than committing it: run `npm version
  <resolved-version> --no-git-tag-version` (rewrites `package.json` in the
  CI workspace only, no commit) immediately before `npm publish`, using the
  same `release-drafter`-resolved version as this proposal's image tag —
  keeping npm and image versions identical without ever hand-maintaining
  `package.json`. (`npm publish` itself has no version-override flag; `npm
  version` is the tool for that.) Not needed by this proposal's Docker-only
  pipeline — captured here for when/if an npm registry target appears.
- **Reuse existing labels (`enhancement` -> minor, `bug` -> patch) instead of
  introducing a full `major`/`minor`/`patch` label set.** Minimizes new
  process for contributors — only one new label (`breaking-change`) needs to
  be created and remembered. Unlabeled/other-labeled PRs default to a patch
  bump, so forgetting to label something never blocks a release, just
  under-bumps it (recoverable by hand-editing the draft before it publishes,
  since drafts are visible/editable up until the `publish-release` job runs
  — though that window is only as long as `build-and-push` takes on a given
  run, since there's no manual approval gate; see "Resolved decisions"
  below).
- **Tag format `v$RESOLVED_VERSION`** (e.g. `v1.4.0`) for both the Git tag/
  release name and the Docker image tag, so the two are trivially
  correlatable by eye. A floating `:latest` tag is updated on every
  successful run alongside the versioned tag.
- **GHCR auth via the built-in `GITHUB_TOKEN`**, not a PAT — needs
  `permissions: packages: write` (image push) and `permissions: contents:
  write` (release/tag creation) set explicitly on the workflow, since the
  default token permissions for a `push` trigger may otherwise be read-only
  depending on repo settings. No new secret to create or rotate.
- **No multi-arch build in v1.** `docker/build-push-action` supports
  multi-platform via buildx + QEMU, but adds build time and complexity for a
  need that doesn't exist yet; flagged as a follow-up if an ARM deployment
  target ever appears.
- **Dockerfile stays minimal and config-free.** Multi-stage to keep the
  runtime image small (no TypeScript/devDependencies in the final layer),
  non-root by default (the official `node:*-alpine` images already ship a
  `node` user), and no `config.json` baked in — matches how config is
  already handled today (`config.example.json` as a template, real config
  supplied externally via `CONFIG_PATH`).

### Task Breakdown

Each task is independently reviewable and ships as its own PR, consistent
with the existing workflow (implement, mark `Status: DONE` here, open PR,
await approval).

#### Task 1 — Dockerfile
**Status:** TODO
**Description:** Add a multi-stage `Dockerfile` (`builder` stage: `node:lts-
alpine`, `npm ci`, `npm run build`; runtime stage: `node:lts-alpine`, `npm ci
--omit=dev`, copy `dist/` from the builder, non-root `node` user, `EXPOSE
3000 3001`, `CMD ["node", "dist/server.js"]`) and a `.dockerignore`
(`node_modules`, `.git`, `test/`, `docs/`, `config.json`, `*.log`, coverage
output if any).
**Acceptance criteria:** `docker build -t mail-tool-server:local .` succeeds
locally. Running it with a mounted `config.json` (copied from
`config.example.json`, pointed at a throwaway/dummy IMAP account so startup
doesn't hang trying to actually connect — or with watch accounts left empty
if the schema allows it) via `-v $(pwd)/config.json:/app/config.json -e
CONFIG_PATH=/app/config.json -p 3000:3000 -p 3001:3001` boots and
`curl localhost:3000/health` returns `{"status":"ok"}`.

#### Task 2 — release-drafter config
**Status:** TODO
**Description:** Add `.github/release-drafter.yml` per the categories/
version-resolver table above, `tag-template`/`name-template`
`v$RESOLVED_VERSION`, and a `template` whose body lists categorized PRs plus
the `docker pull ghcr.io/nielssj/mail-tool-server:v$RESOLVED_VERSION` line.
Create the one new `breaking-change` label (`gh label create breaking-change
--color ... --description "Bumps the major version"`).
**Acceptance criteria:** Manually triggering `release-drafter` against the
current repo state (e.g. via a scratch `workflow_dispatch`-only workflow
used just for this task's verification, removed again before merging, or
`gh api` / the `release-drafter` CLI locally if convenient) produces a
sensible draft release body with correctly categorized entries and a
plausible first version.

#### Task 3 — `release.yaml` workflow + `v0.1.0` bootstrap
**Status:** TODO
**Description:** Implement the three-job pipeline described above
(`draft-release` -> `build-and-push` -> `publish-release`), wiring
`draft-release`'s `tag_name` output through to the Docker tags in
`build-and-push`, and gating `publish-release` on `build-and-push` via
`needs`. Explicit `permissions: contents: write, packages: write` on the
workflow (or per-job, whichever is cleaner once written).

**One-time bootstrap, done by hand right after this task's PR merges (not by
the workflow):** manually create and publish a `v0.1.0` GitHub Release (`gh
release create v0.1.0 --title v0.1.0 --notes "Initial release: adds
automated GHCR image publish + release-drafter versioning."`), and manually
build + push the matching images (`docker build`, then push both
`ghcr.io/nielssj/mail-tool-server:v0.1.0` and `:latest`) so the very first
release and its image genuinely exist and correspond — the same invariant
the automated pipeline enforces for every release after this one. This sets
a known-good, real baseline for `release-drafter` to resolve *forward* from
on the next merge (e.g. a `bug`-labeled PR after this bootstrap resolves to
`v0.1.1`; an `enhancement`-labeled one resolves to `v0.2.0`), rather than
depending on `release-drafter`'s no-prior-release fallback behavior (which
bumps from `package.json`'s `"1.0.0"` and would land somewhere in the
`v1.x`/`v2.x` range instead of the requested `v0.1.0` start).
**Acceptance criteria:** After the manual `v0.1.0` bootstrap above, a real
merge to `main` (the natural trigger — no sensible way to fully dry-run a
GHCR push) results in: a new image visible at
`ghcr.io/nielssj/mail-tool-server` tagged both `latest` and the resolved
version (`v0.1.1`/`v0.2.0`/etc. depending on that PR's label), and a
published (non-draft) GitHub Release at that same tag with no attached
files. Verified manually once this task's PR is merged.

#### Task 4 — Docs
**Status:** TODO
**Description:** README gets a short "Container image" section: where the
image lives (`ghcr.io/nielssj/mail-tool-server`), the tag scheme (`vX.Y.Z` +
`latest`), how to pull and run it (mirroring Task 1's manual test command),
and a pointer to the label table above so contributors know which PR label
drives which version bump.
**Acceptance criteria:** A contributor can read the README section alone and
know (a) which label to add to a PR for a minor vs. patch vs. major release,
and (b) the exact command to pull and run the latest published image.

---

### Resolved decisions

1. **Starting version: `v0.1.0`.** Achieved via a one-time manual bootstrap
   in Task 3 (real `v0.1.0` release + matching pushed images), not by
   relying on `release-drafter`'s no-prior-release fallback — see Task 3.
   Every release after that is fully automated, resolved forward from
   `v0.1.0` by label.
2. **GHCR package visibility: private.** This is already the GHCR default on
   first push, so no extra workflow step or manual settings change is
   needed — noted here as a confirmed, intentional choice rather than an
   accident of the default.
3. **No additional approval gate before `publish-release`.** PR review +
   the existing `ci.yaml` checks (required before merge) are the gate.
   Once a PR merges to `main`, the release/build/publish pipeline runs to
   completion automatically with no further human checkpoint — matching the
   "whenever we merge to main" framing in this proposal's goal.
