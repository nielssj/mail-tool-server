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
back-fills `patch: { labels: [] }`. Also *thought* to have discovered along
the way: with no prior release at all, `$RESOLVED_VERSION` unconditionally
resolves to `0.1.0` regardless of labels (verified by calling
`getVersionInfo` with `versionKeyIncrement` set to each of
`major`/`minor`/`patch` with no prior release — all three returned
`0.1.0`). **This turned out to be wrong** — see the "Resolved decisions"
entry on starting version below. The local harness here was built against
the npm package `release-drafter-github-app` at whatever version `npm
install` resolved (`6.1.0`), never checked against the actually-deployed
`v7.6.0` (a full rewrite, different internal logic entirely — different
repo layout, different file organization, presumably more differences not
yet enumerated). The real production run (see below) did independently
confirm template rendering works (the actual published release body
correctly substituted `v0.0.1` into the `docker pull ...` line) and that
omitting `version-resolver.patch` doesn't crash (the real run didn't
error). Categorization specifically wasn't re-confirmed against real
labeled PRs in production yet — the triggering PR carried no label, so the
real run's changelog body doesn't exercise that path. Worth a real check
next time a labeled PR triggers a run, rather than continuing to lean on
the mismatched-version harness for that claim.
**Acceptance criteria:** A sensible draft release body with correctly
categorized entries and a plausible first version — confirmed via the local
harness described above rather than a live scratch workflow (not possible
before this config exists on `main`; see above). The specific *version
number* claim from that harness was later found wrong on the real first
run — see "Resolved decisions" below.

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

**Revised after review — `release-drafter` pinned to a commit SHA, not the
`v7` tag.** Third-party (non-GitHub-authored) actions are a supply-chain
risk if the tag is ever moved — a compromised maintainer account could push
malicious code to `v7` and every consumer would pick it up silently on the
next run. `release-drafter/release-drafter` is community-maintained (not a
GitHub- or Docker-authored action), so both its `uses:` lines now pin the
exact commit SHA `v7` resolved to at the time of this change
(`eada3c96a64734dd381cfbda23511034e328ddb0`, confirmed via `git ls-remote`
— dereferencing the annotated tag, not the tag object's own SHA — and
cross-checked against the GitHub API commit endpoint), with a trailing
`# v7.6.0` comment recording which release that corresponds to for future
bumps. `actions/checkout` (GitHub-authored) and `docker/login-action`/
`docker/build-push-action` (Docker, Inc.-authored, same trust tier judgment
call) were kept on major-version tags per explicit direction — SHA-pinning
scope limited to `release-drafter` for this PR.

**No manual `v0.1.0` bootstrap done — and it turned out the real fallback
isn't `0.1.0` either.** The original plan here was a one-time manual
release + image push to seed a `v0.1.0` baseline. That was dropped after
Task 2's local testing seemed to show `release-drafter`'s no-prior-release
fallback is unconditionally `0.1.0` regardless of labels. Both the original
assumption *and* the thing that superseded it were wrong: the real first
run (this task's own PR merging to `main`) published `v0.0.1`, not
`v0.1.0`. Root cause, confirmed by reading the actually-deployed `v7.6.0`
source directly: with no prior release it starts from `0.0.0` and applies
whatever bump the triggering PR's labels resolve to (correctly, unlike what
Task 2's mismatched-version harness showed) — this PR carried no label, so
`version-resolver.default: patch` applied, giving `0.0.1`. Presented to the
user afterward with remediation options; decision was to accept `v0.0.1` as
the real starting point rather than delete and re-bootstrap. Full writeup
in "Resolved decisions" below.

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
permissions setup works. Removed the scratch workflow afterward. Leftover
`:scratch-test` package cleaned up afterward (by hand, via `gh api -X
DELETE /users/nielssj/packages/container/mail-tool-server` — fine-grained
PATs don't support Packages/Container Registry operations at all per
GitHub's own docs, so this needed a classic-PAT-scoped `read:packages`/
`delete:packages` token instead; it was also the package's only version, so
GitHub required deleting the whole package rather than just that one
version). The package will be recreated fresh, correctly, on the first real
`release.yaml` run.
**Acceptance criteria:** A real merge to `main` results in a new image
visible at `ghcr.io/nielssj/mail-tool-server` tagged both `latest` and the
correctly resolved version, and a published (non-draft) GitHub Release at
that same tag with no attached files. **Confirmed on the real first merge**
(this task's own PR): all three jobs succeeded, a real release
([v0.0.1](https://github.com/nielssj/mail-tool-server/releases/tag/v0.0.1))
was published with no attached files, and both `ghcr.io/nielssj/
mail-tool-server:v0.0.1` and `:latest` were pushed with real digests. The
resolved *version number* (`v0.0.1` instead of the intended `v0.1.0`) was
wrong for reasons unrelated to this task's own logic — see "Resolved
decisions" below — but the pipeline mechanics themselves (draft, build,
push, gate, publish, no artifacts) are now verified end to end for real,
not just locally simulated.

#### Task 4 — Docs
**Status:** DONE
**Description:** Added a "Container image" section to the README: where the
image lives (`ghcr.io/nielssj/mail-tool-server`, noting it's currently
**private** and requires `docker login ghcr.io` with `read:packages` first
— GHCR packages default to private on first push, matching the "Resolved
decisions" entry on visibility), the tag scheme (`vX.Y.Z` + `latest`), the
pull/run command (mirroring Task 1's manual test command), a note that each
image has a matching GitHub Release with no attached files, and a table
mapping PR label -> version bump alongside a pointer to
`.github/release-drafter.yml` for the full config.

Also corrected the record on this doc itself while doing this task: the
"Resolved decisions" entry on starting version, and the Task 2/Task 3
write-ups, previously claimed `v0.1.0` would be (and was) the automatic
starting point. The real first run (Task 3's own PR merging) published
`v0.0.1` instead — see the corrected "Resolved decisions" entry below for
the full root-cause writeup. Not this task's own work, but fixed here since
it's a documentation-accuracy issue discovered while working in this file.
**Acceptance criteria:** A contributor can read the README section alone
and know (a) which label to add to a PR for a minor vs. patch vs. major
release, and (b) the exact command to pull and run the latest published
image. Both satisfied by the added section.

---

### Resolved decisions

1. **Starting version: actually `v0.0.1`, not `v0.1.0` — accepted as-is.**
   Originally planned as a one-time manual bootstrap release, then
   superseded during Task 2 after local testing seemed to show
   `release-drafter`'s no-prior-release fallback is unconditionally `0.1.0`
   regardless of labels, so no manual bootstrap was done. **That Task 2
   finding was wrong**, discovered when Task 3's PR merged and the real
   first run published `v0.0.1`: the local verification had tested against
   the npm package `release-drafter-github-app` at whatever version `npm
   install` resolved as latest (`6.1.0`) without checking it matched the
   actually-deployed, SHA-pinned action (`v7.6.0`) — a full, unrelated
   rewrite of the same project (different repo layout entirely:
   `src/actions/drafter/lib/...` vs. the old `lib/`). Confirmed by reading
   v7.6.0's real source directly: with no prior release, it starts from
   `0.0.0` and applies whichever bump the merged PR's labels actually
   resolved to (correct semver behavior, unlike what was tested) — since
   the triggering PR carried no version label, `version-resolver.default:
   patch` applied, giving `0.0.1`. Presented to the user with remediation
   options (delete-and-rebootstrap at `v0.1.0`, merge a future
   `enhancement`-labeled PR to bump to `v0.1.0` naturally, or accept
   `v0.0.1`); **decision: accept `v0.0.1`** as the real starting point — no
   corrective action taken, the release and images stand as published.
   Lesson for future local verification against a pinned third-party
   action: match the exact pinned version/commit, not just "whatever's
   latest on npm" for a same-named package.
2. **GHCR package visibility: private.** This is already the GHCR default on
   first push, so no extra workflow step or manual settings change is
   needed — noted here as a confirmed, intentional choice rather than an
   accident of the default.
3. **No additional approval gate before `publish-release`.** PR review +
   the existing `ci.yaml` checks (required before merge) are the gate.
   Once a PR merges to `main`, the release/build/publish pipeline runs to
   completion automatically with no further human checkpoint — matching the
   "whenever we merge to main" framing in this proposal's goal.
