# Working conventions for this repo

## Task workflow (e.g. docs/mcp-tool-interface-proposal.md)

- Each task in a proposal doc's "Task Breakdown" is implemented on its own
  feature branch and shipped as its own PR.
- Execute the implementation directly in this session — do not delegate to a
  sub-agent.
- Before pushing a branch with an open PR, run the repo's checks locally and
  fix any failures first: `npm run lint`, `npx tsc -p tsconfig.json --noEmit`
  (or `npm run build`), and `npm test`. If the change touches a runnable
  entrypoint (e.g. a new server/script), smoke-test it locally too.
- When a task is complete, mark it `Status: DONE` in the proposal doc as part
  of the same PR.
- Open the PR when the task is done; do not merge it.

## Git / PR discipline

- The user reviews every PR before anything merges to `main` — never merge,
  even if checks pass.
- Don't push to a branch with an open PR without running local checks first.
