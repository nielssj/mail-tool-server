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
- Broad changes to the existing `ci.yaml` PR-check workflow — the
  release/publish pipeline itself is a new, separate workflow, triggered
  differently (`push` to `main`, not `pull_request`). (One small, explicitly
  requested addition to `ci.yaml` — a `docker-build` smoke-test job — is in
  scope; see Task 1.)
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
Dockerfile                     Multi-stage: `builder` (node:24-alpine,
                               `npm ci`, `npm run build`) -> runtime
                               (node:24-alpine, `npm ci --omit=dev`,
                               copies `dist/` from builder, runs as the
                               image's existing non-root `node` user).
                               Node version pinned to the current Active
                               LTS major via a single `ARG NODE_VERSION`,
                               not the floating `lts` tag — see Task 1.
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

1. **`draft-release`** — runs `release-drafter/release-drafter@v7` with
   `publish: false` against `.github/release-drafter.yml`. Outputs
   `tag_name` (e.g. `v1.4.0`), used by both later jobs. This both keeps a
   live, always-current draft of "what the next release will look like"
   visible on GitHub at all times, and tells the pipeline what version this
   run is building — without making anything public yet.
2. **`build-and-push`** (`needs: draft-release`) — logs into `ghcr.io` via
   `docker/login-action` using the built-in `GITHUB_TOKEN`, then builds the
   image from the new `Dockerfile` and pushes it via
   `docker/build-push-action`, tagged
   `ghcr.io/${{ github.repository }}:${{ needs.draft-release.outputs.tag_name }}`
   and `ghcr.io/${{ github.repository }}:latest`.
3. **`publish-release`** (`needs: [draft-release, build-and-push]`) —
   re-runs `release-drafter/release-drafter@v7`, same config, with
   `publish: true` and `tag`/`name` pinned to `draft-release`'s already-
   resolved `tag_name` (not recomputed). Because this job only runs after
   `build-and-push` succeeds, a published release always has a matching
   image already sitting in GHCR — never a public release pointing at an
   image that failed to build.

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
**Status:** DONE
**Description:** Added a multi-stage `Dockerfile` (`builder` stage:
`node:24-alpine`, `npm ci`, `COPY . .`, `npm run build`; `runtime` stage:
`node:24-alpine`, `npm ci --omit=dev`, non-root `node` user, `EXPOSE 3000
3001`, `CMD ["node", "dist/server.js"]`) and a `.dockerignore`
(`node_modules`, `dist`, `.git`, `.github`, `config.json`/`config.*.json`,
`docs`, `README.md`, etc.).

**Revised after initial review — pinned Node version, not floating `lts`.**
The first pass used `node:lts-alpine`, which silently tracks whatever
Node.js currently calls "LTS" — meaning the image's Node major could jump
(e.g. 24 -> 26) with no corresponding change in this repo to review, the
exact risk flagged in review. Switched to `ARG NODE_VERSION=24-alpine`
(declared once, referenced by both stages), pinned to the current Active
LTS major confirmed via a web search at the time of this change (Node 24 is
Active LTS; Node 22 is Maintenance LTS; Node 26 is `Current`, not LTS until
October 2026 — sources in the PR). Moving to a new major now requires
editing that one `ARG` line, which goes through this repo's normal PR
review — "validate whenever we bump" happens for free via that review, no
extra tooling needed for that alone.

**Deviation found during implementation:** `tsconfig.json`'s `rootDir: "."`
plus its `include` (`src/**`, `test/**`, `scripts/**`) means `npm run build`
actually emits to `dist/src/server.js`, not `dist/server.js` —
`package.json`'s existing `main`/`start` (`node dist/server.js`) has
apparently been broken pre-existing, unrelated to this proposal, likely
never exercised since local dev always runs `npm run dev` (`tsx
src/server.ts`) instead. Rather than fix that repo-wide (out of scope here,
and it's not obviously safe to change `tsconfig.json`'s `include`/`rootDir`
without also affecting what CI's `Build` step type-checks), the runtime
stage copies just `dist/src` back to `./dist`
(`COPY --from=builder /app/dist/src ./dist`), which both restores the
expected `dist/server.js` path and drops the compiled `test`/`scripts`
output the image has no use for. This is safe because the only two modules
that import anything outside `src/` (`mcp/server.ts` and
`telemetry/instruments.ts`, both `import packageJson from
'../../package.json'`) resolve that relative path against the runtime
stage's own `/app/package.json` (copied in for `npm ci --omit=dev`
regardless) once flattened — verified by simulating both stages'
file layout by hand (no nested-Docker daemon available in this sandbox to
run a literal `docker build`) and booting the result with `{"accounts":
[]}`, confirming `GET /health` returns `{"status":"ok"}` and the MCP port
responds correctly. Documented as a code comment directly in the
Dockerfile. Left `package.json`'s `main`/`start` fields as-is since fixing
them is unrelated to this proposal — flagged separately for a possible
follow-up outside this task.
**Follow-up, same task/PR — `docker-build` CI job:** this sandbox has no
working Docker daemon (confirmed: installing `docker.io` and starting
`dockerd` fails here with `failed to mount overlay: operation not
permitted` / an `iptables` permission error — no privileged
overlay/netfilter access), so a literal `docker build`/`docker run` could
only be simulated by hand, not actually executed, in this session. Since
GitHub-hosted runners *do* have a working Docker daemon, added a new
`docker-build` job to the existing `.github/workflows/ci.yaml` (out of this
proposal's original scope, but small and directly needed to actually verify
the Dockerfile — added with explicit go-ahead) that runs on every PR:
`docker build`s the image, starts a container with a minimal `{"accounts":
[]}` config mounted, polls `GET /health` for up to 20s, checks `GET /mcp`
returns `405`, then always prints container logs and tears the container
down. This becomes the permanent, real verification of the Dockerfile going
forward (not just for this task) — every future PR that changes the
Dockerfile, `package.json`, or app source gets a real `docker build` +
boot-and-serve check before merge. Whether it's a *required* status check
is a branch-protection setting, not something this workflow file controls —
left for the user to configure if wanted.
**Acceptance criteria:** `docker build -t mail-tool-server:local .` succeeds
locally. Running it with a mounted `config.json` (copied from
`config.example.json`, pointed at a throwaway/dummy IMAP account so startup
doesn't hang trying to actually connect — or with watch accounts left empty
if the schema allows it) via `-v $(pwd)/config.json:/app/config.json -e
CONFIG_PATH=/app/config.json -p 3000:3000 -p 3001:3001` boots and
`curl localhost:3000/health` returns `{"status":"ok"}`. Confirmed via the
new `docker-build` CI job on this task's own PR (see below) rather than
locally, since this sandbox can't run Docker at all.

#### Task 2 — release-drafter config
**Status:** DONE
**Description:** Added `.github/release-drafter.yml` per the categories/
version-resolver table above, `tag-template`/`name-template`
`v$RESOLVED_VERSION`, and a `template` whose body lists categorized PRs plus
the `docker pull ghcr.io/nielssj/mail-tool-server:v$RESOLVED_VERSION` line.
Created the one new `breaking-change` label (`gh label create
breaking-change --color b60205 --description "Bumps the major version
(release-drafter)"`).

**How this was actually verified (revised from the planned approach):** the
acceptance criteria below assumed a scratch `workflow_dispatch` workflow
could exercise `release-drafter` from a feature branch. Two dead ends found
along the way, in order: (1) `workflow_dispatch` requires the workflow file
to already exist on the *default* branch to be dispatchable via API at all
— switched the scratch workflow to `pull_request` instead, which doesn't
have that restriction; (2) even so, `release-drafter/release-drafter`
itself fetches `.github/release-drafter.yml` via the GitHub API from the
**default branch specifically**, regardless of which ref triggered the
workflow — confirmed by the actual failure: `Configuration file
.github/release-drafter.yml is not found. The configuration file must
reside in your default branch.` So a live GitHub Actions run genuinely
cannot validate this config before it's on `main`, no matter the trigger
type.

Instead of merging first to unlock a live run, installed the actual
underlying package (`release-drafter-github-app` on npm — the real
`release-drafter/release-drafter` source, not a live GitHub Action) in a
scratch directory and called its internal `validateSchema` +
`generateReleaseInfo` functions directly against this repo's real
`.github/release-drafter.yml` and a set of realistic fake merged PRs
(`breaking-change`, `enhancement`, `bug`, `documentation`, and one
unlabeled). This is more precise than a live run would have been anyway —
fully offline, repeatable, and inspects the exact rendered body rather than
having to eyeball a GitHub UI draft. Confirmed: all four labeled categories
render under the correct headings with the correct PRs; the unlabeled PR
appears in `$CHANGES` without a category heading (release-drafter has no
true wildcard/catch-all category — noted as a comment in the config); the
`docker pull ...v$RESOLVED_VERSION` line substitutes correctly; and — most
significantly — **omitting `version-resolver.patch` (relying on `default:
patch` alone) does not crash**, because `validateSchema` deep-merges the
user config onto `DEFAULT_CONFIG` before Joi validation runs, which
back-fills `patch: { labels: [] }`. Also discovered along the way: with no
prior release at all, `$RESOLVED_VERSION` **unconditionally resolves to
`0.1.0`**, regardless of which labels are present on the triggering PRs
(verified directly by calling `getVersionInfo` with `versionKeyIncrement`
set to each of `major`/`minor`/`patch` with no prior release — all three
return `0.1.0`). This changes Task 3 — see below.
**Acceptance criteria:** A sensible draft release body with correctly
categorized entries and a plausible first version — confirmed via the local
harness described above rather than a live scratch workflow (not possible
before this config exists on `main`; see above).

#### Task 3 — `release.yaml` workflow
**Status:** DONE
**Description:** Implemented the three-job pipeline (`draft-release` ->
`build-and-push` -> `publish-release`), `permissions: contents: write,
packages: write` set once at the workflow level. Two refinements beyond the
original description: (1) image tags use `ghcr.io/${{ github.repository }}`
rather than the hardcoded repo path, so it never drifts if the repo is ever
renamed; (2) `publish-release` explicitly passes `tag`/`name` inputs pinned
to `draft-release`'s already-resolved `tag_name` output (requires listing
`draft-release` directly in `publish-release`'s own `needs:` — job outputs
are only visible to *direct* dependents, not transitive ones), rather than
letting `release-drafter` recompute the version a second time — closes a
small race window where a PR merging to `main` between the two jobs could
otherwise cause `publish-release` to publish a different version than the
one `build-and-push` just tagged and pushed.

Actions pinned to their current latest majors, verified via each action's
real `action.yml`/GitHub releases rather than assumed from the earlier
architecture sketch above (which had guessed `@v6`/`v3`): `release-drafter/
release-drafter@v7` (confirmed output `tag_name` still exists, and a new
`token` input defaults to `github.token` so nothing extra needs passing),
`docker/login-action@v4`, `docker/build-push-action@v7`.

**No manual `v0.1.0` bootstrap needed — revised after Task 2.** The
original plan here was a one-time manual release + image push to seed a
`v0.1.0` baseline, on the assumption that `release-drafter`'s
no-prior-release fallback would instead bump from `package.json`'s
`"1.0.0"` and land somewhere in `v1.x`/`v2.x`. Task 2's local testing
against the actual `release-drafter` source disproved that assumption:
with zero prior releases, `$RESOLVED_VERSION` unconditionally resolves to
`0.1.0` regardless of any PR's labels — confirmed by direct function calls,
not just documentation. So the very first real run of this workflow, on
the very first merge to `main` after it ships, naturally produces exactly
`v0.1.0` with no manual step. Every merge after that behaves normally
(`semver.inc` off the real previous release).

**Verification:** `release.yaml` itself triggers only on `push` to `main`,
so — like Task 2's config — it cannot be exercised end to end before
merging (no way to fully dry-run a GHCR push or a real release publish
either). What *could* be verified for real without merging: whether
`GITHUB_TOKEN` can actually push to this repo's GHCR at all — a genuine
unknown (org/repo package-write policies aren't visible from the workflow
file), not something to assume. Added a temporary `pull_request`-triggered
scratch workflow that logged into GHCR and ran a real
`docker/build-push-action` push to a throwaway `:scratch-test` tag. It
succeeded — real digest returned, no errors — confirming the token/
permissions setup works. Removed the scratch workflow afterward. **Leftover
cleanup needed:** the `:scratch-test` package version itself is still
sitting in GHCR — this session's token has no `packages:read`/
`packages:delete` scope to remove it via API, so it needs deleting by hand
(GitHub UI, or grant that scope) — harmless in the meantime, since
`release.yaml` only ever pushes `:latest`/`:vX.Y.Z` tags, never
`:scratch-test`.
**Acceptance criteria:** A real merge to `main` results in: a new image
visible at `ghcr.io/nielssj/mail-tool-server` tagged both `latest` and
`v0.1.0` (the very first run) or the correctly resolved next version
(subsequent runs), and a published (non-draft) GitHub Release at that same
tag with no attached files. Still to be confirmed on an actual merge to
`main` after this task's PR merges — the GHCR-push mechanism itself is now
verified (above), but a full live run of all three jobs together, including
the real `release-drafter` publish step, is not.

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

1. **Starting version: `v0.1.0`.** Originally planned as a one-time manual
   bootstrap release (see Task 3's original description in git history) on
   the assumption `release-drafter`'s no-prior-release fallback would
   otherwise bump from `package.json`'s `"1.0.0"`. Superseded during Task 2:
   local testing directly against `release-drafter`'s source confirmed the
   real fallback with zero prior releases is unconditionally `0.1.0`,
   regardless of labels — no manual bootstrap needed. The very first real
   run of Task 3's workflow produces `v0.1.0` on its own; every release
   after that resolves normally from the real previous release.
2. **GHCR package visibility: private.** This is already the GHCR default on
   first push, so no extra workflow step or manual settings change is
   needed — noted here as a confirmed, intentional choice rather than an
   accident of the default.
3. **No additional approval gate before `publish-release`.** PR review +
   the existing `ci.yaml` checks (required before merge) are the gate.
   Once a PR merges to `main`, the release/build/publish pipeline runs to
   completion automatically with no further human checkpoint — matching the
   "whenever we merge to main" framing in this proposal's goal.
