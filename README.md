# claude-loop-runner

Runs the Claude Code CLI unattended, in a loop, against a file-based plan —
until the plan reports `status: done`, gets `status: blocked` (and needs a
human), or hits a hard iteration cap.

Every iteration is a **fresh, non-interactive** `claude --print` call (no
`--continue`/`--resume`) — that's what keeps context from growing across
iterations, instead of `/clear`-ing a single giant session. Long-term memory
lives in two files inside the target project, not in the conversation.

## Why this exists

See the plan this was built from:
`~/.claude/plans/c-users-jeanz-onedrive-desktop-roi-labs-idempotent-meteor.md`.
Short version: `pexpect`/TUI screen-scraping is the wrong layer and doesn't
work on Windows; `claude --print` + file-based state + the account-cooldown
pattern already proven in the Polaris Teams project (`ROI Labs\Imob\sofia-next`)
covers the same ground more reliably.

## Setup

1. In the target project's repo root, write `macro_plan.md` by hand: the
   scope, architecture, and task list. Tag each task `[plan]` (gets `--effort
   high`) or `[build]` (gets `--effort low/medium`) so the loop knows how much
   deliberation each step deserves.
2. Set the account pool as env vars (pick ONE):
   - `CLAUDE_CODE_OAUTH_TOKEN_1`, `CLAUDE_CODE_OAUTH_TOKEN_2`, `CLAUDE_CODE_OAUTH_TOKEN_3`, …
   - or `CLAUDE_CODE_OAUTH_TOKENS` — comma/newline-separated list.
   - or just `CLAUDE_CODE_OAUTH_TOKEN` for a single account.
   - Optional: `CLAUDE_TOKEN_COOLDOWN_MS` to override the 5h default cooldown.
3. Check out `main` in the target repo (the runner refuses to start otherwise).
4. Run:
   ```
   node src/runner.mjs "<path to target repo>" --max-iterations 20
   ```

### Local UI (optional)

`npm run ui` → http://127.0.0.1:4517 — pick the target repo, iterations and
tokens (one per line; empty box reuses the server's env / an optional `.env`
file next to `package.json`), start/stop, live logs, `current_state.md` panel.
Binds 127.0.0.1 only. Smoke test: `node src/ui.mjs --check`.

`--max-iterations` is required on purpose — there is no "unlimited" default,
so a badly-specified task can't burn the whole weekly quota across all
accounts unattended.

**Every commit lands on `main` and gets pushed immediately** — by explicit
decision (2026-07), not a worktree/branch. If this project auto-deploys on
push to `main` (this one does), each iteration goes to production as soon as
it's done, with no human review step in between. There is no branch cushion
left; `--disallowedTools` is the only safety net (see below).

## What it does each iteration

1. Confirms `main` is checked out in the target repo (errors out otherwise).
2. Reads `current_state.md` (seeded on first run) for `status` and
   `next_effort`.
3. Picks an available account from the pool (skips ones in cooldown),
   invokes `claude --print` with that account's `CLAUDE_CODE_OAUTH_TOKEN`,
   `--effort <next_effort>`, and a prompt telling it to do the next task from
   `macro_plan.md` and rewrite `current_state.md` with what changed and
   what's next.
4. On a rate-limit banner (regex-detected, whether it comes back as a
   non-zero exit or as normal-looking stdout with exit 0): marks that account
   cooling and retries the same iteration on the next account. If every
   account is cooling, sleeps until the earliest reset time, then resumes —
   without spending an iteration on the wait.
5. On success, rebases on `origin/main` (crons/PR merges move it) and pushes
   immediately. The same sync also runs before each iteration starts, so work
   never builds against a stale tree; a rebase conflict stops the loop for
   human review.
6. Stops when `current_state.md` says `status: done`, says `status: blocked`
   (a human needs to look — this is a first-class stop, not a bug), or
   `--max-iterations` is reached.

## Safety, baked in (do not remove)

- `git push --force`, `git push -f`, `git reset --hard` are hard-blocked via
  `--disallowedTools`, regardless of `--permission-mode`.
- Refuses to run unless `main` is checked out (no silent push to some other
  branch the human happened to be on).
- `--max-iterations` is mandatory.
- `status: blocked` stops the loop instead of forcing progress — mirrors the
  "escape hatches" warning in the (unused) `ralph-loop` plugin.
- There is deliberately no worktree/branch cushion anymore — review the
  scope in `macro_plan.md` before a run, not the diff after.

## Manual verification

1. Point it at a scratch repo (with its own throwaway `origin` remote) with a
   2-step `macro_plan.md`, `--max-iterations 3`, one account: confirm two
   `claude --print` calls happen, each commits AND pushes to `main`,
   `current_state.md` updates, and it stops at `status: done` before the cap.
2. Set `CLAUDE_TOKEN_COOLDOWN_MS=1000` with 2+ accounts and force a limit on
   purpose (or just watch real usage) to confirm rotation actually happens
   and gets logged.
3. Add a debug line dumping `process.env` inside `claude-cli.mjs` for one run
   to confirm `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are absent from the
   child process.
4. Ask a test task to run `git push --force` on purpose and confirm it's
   refused.
