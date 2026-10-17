---
name: task
description: Run one Personal API task from docs/PLAN.md end to end (for example "/task M1-05", "/task M3-R but use opus high"). The session reads the project docs first, then implements and tests the task itself, with no per-task subagents. Only Mx-R reviews launch a reviewer subagent. Use when the user asks to do, run, review or implement a task ID such as M0-03 or M2-R.
argument-hint: <task-id> [auto-merge] [model/effort override, e.g. "opus high"]
---

# /task: run one plan task inline

You do the work yourself in this session: no `builder`, `test-writer` or other subagent per task. Only `Mx-R` launches a subagent (`reviewer`, Opus). DeepSeek and `opencode-delegate` are not used; ignore any leftover `{deepseek}` marker. Arguments: `$ARGUMENTS`.

## 0. Parse the arguments and preflight

- **Task ID** (case-insensitive: `m3-r` = `M3-R`). **`auto-merge`** if present. **Override**: free text such as "use opus high" or "effort medium" replaces the tag's model/effort for this run. Say in one line that you are overriding the tag.
- **Model check:** the tag says `H` → Haiku, `S` → Sonnet, `O` → Opus (reviews only). If the session runs a different model and the user gave no override, say so in one line (`/model sonnet`) and ask before implementing. Opus implementing needs the user's explicit say-so (CLAUDE.md rule from 2026-10-16).
- **Preflight (one command each, read the output):**
  - `git status -sb`: a clean tree on `main` (or say what is uncommitted and ask).
  - `docker info`: decides whether `test:int` and e2e can run locally. If the task touches the DB and Docker is off, offer to start Docker Desktop. Otherwise plan to say "integration and e2e run in CI only".
  - `gh run list --branch main -L 5 --json conclusion,displayTitle`: know about red or flaky `main` CI **before** you start, so a pre-existing failure is not blamed on your diff.

## 1. Look up the task

- Find the line `- [ ] **<ID> [<M> · <effort>] …**` in `docs/PLAN.md` §10.
- If the box is already ticked, or the ID is missing, stop and tell the user.
- If an earlier task in the same milestone is still unticked, warn the user and ask before continuing. Tasks are ordered on purpose.

## 2. Read everything first (no code before this is done)

1. `CLAUDE.md` in full (invariants, conventions, gotchas).
2. The task line and its "done when" criteria, plus every other `docs/PLAN.md` section it relies on (architecture, data model, API, rule format, browser targets).
3. The ADRs in `docs/adr/` that touch the area.
4. The existing code and tests beside the files you will change, the test harnesses they use (`apps/web/src/test/`, `apps/api/test/`, `apps/extension/test/**/support/`), and the contracts in `packages/contracts` you will use.

Then give the user two or three lines: what you will build and anything the plan leaves open. If the plan is missing something the task needs, or code and plan disagree, **stop and ask**. Don't invent API surface (routes, DTOs, formats) on your own.

## 3. Prepare the branch

`git switch main && git pull --ff-only`, then `git switch -c <id-lowercase>-<short-name>`. `Mx-R` reviews start without a branch (step 7). Their fixes get one.

## 4. Implement and test

- Write the tests from the "done when" criteria. On `high`/`xhigh`/security-touching tasks, write them first and **run them to watch them fail for the right reason** (an assertion, not an import error). A new route also gets a cross-tenant test (and an entry in the cross-tenant sweep).
- Then implement until they pass. Never weaken a test to get green.
- Follow the conventions and invariants in `CLAUDE.md`.
- **Contracts are consumed from `dist`:** after changing `packages/contracts`, run `pnpm --filter @personal-api/contracts build` before testing `api`, `web` or `extension`. Otherwise they still see the old schemas, and unrelated tests fail in confusing ways.
- **Secrets in the dashboard** (ingest keys, pairing codes): keep them in component state only. A React Query mutation or query that *returns* a secret keeps it in the cache (`reset()` does not remove it), so the mutation resolves to nothing and sets state instead.
- **Dependencies:** only when the plan names them or the task can't be done without one. Pin the exact version, and choose a release that is at least two weeks old (`npm view <pkg> time --json`). Give the reason in the PR body.
- Auth, tenant scoping, key handling or an invariant question you can't settle from the docs: stop and tell the user with the evidence.

## 5. Verify (never trust "done" alone)

Run and read the output: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:int` if you touched the DB or added routes and Docker is running. If Docker is off, say that integration and e2e only run in CI. Don't claim they passed.

**A failure outside your diff:**
1. Rerun that one test file in isolation a few times.
2. Check whether it already fails on `main`: `gh run list --branch main -L 8 --json conclusion,headSha`, then `gh run view <id> --log-failed | grep -E "FAIL |##\[error\]"`.
3. If it's a pre-existing flake, say so with the evidence (how often it fails, and on which runs). Don't retry CI more than once to get green. Find the cause, and propose a separate small fix PR (test-only if the bug is in the test).

## 6. Ship

1. Tick the task's box in `docs/PLAN.md` on the branch. Commit with Conventional Commits and the attribution trailer Claude Code gives you. The body says *what changed and why*, in a few bullets.
2. Push and open a PR to `main`. Body: **task ID**, a summary per change, **checks run** (with counts), **not run locally** (and why), **follow-ups**, and the reason for any new dependency.
3. `gh pr checks <n> --watch`. If CI fails, read the log (`gh run view --job <id> --log-failed`) and fix it. A failure outside your diff: step 5.
4. Merge: without `auto-merge`, give the user the exact commands and wait for approval. When PRs depend on each other, give them in order, for example:
   ```
   gh pr merge <a> --squash --delete-branch
   gh pr update-branch <b>
   gh pr checks <b> --watch
   gh pr merge <b> --squash --delete-branch
   ```
   With `auto-merge`, merge only when CI is green. After a merge the user confirms: `git switch main && git pull --ff-only`.

## 7. `Mx-R` review tasks

1. **Scope:** the commits merged for milestone Mx. Find the range with `git log --oneline main` (from the last commit of the previous milestone to the newest Mx commit). Skip docs-only process commits, and pass the range explicitly (`git diff <from>..<to>`).
2. **Launch one `reviewer` subagent:** `model: opus`, the tagged effort unless the user overrode it. Point it at `CLAUDE.md` and the Mx lines in `docs/PLAN.md` §10. List what to check, in order of priority:
   - tenant scoping and cross-tenant tests
   - auth guards and CSRF on cookie-auth mutations
   - no string SQL, and validation of cursors and filters
   - log redaction, and dropped events kept as counters only
   - contracts-first (no duplicated shapes)
   - RFC 9457 errors, and keyset cursors (never offset)
   - secrets not lingering in caches or storage
   - whether the tests really cover the "done when" criteria
   - drift between the plan and the code

   Ask for a verdict, then Blocker / Should-fix / Nit findings, each with file:line, a failure scenario and a fix. Ask it to verify each finding before reporting it, and to say what it did not run.
3. **Report** the findings grouped the same way, and ask the user which to fix. Don't fix silently.
4. **Fixes** go on one branch, `mx-r-review-fixes`: a test first for each finding (watch it fail), then the fix. Plan drift is fixed in `docs/PLAN.md`. Anything that needs Docker evidence (`EXPLAIN`), a schema change or a later milestone goes in the PR as a follow-up, not into the fix.
5. **Tick `Mx-R`** in that same PR when the verdict is `approve`. With no fixes, tick it in a small `docs:` PR.

## 8. Showing the result (when the user wants to see it)

- **Ports:** API + dashboard on `:3000`, WXT dev server on `:3100`, Postgres on `:5433`. Never use `:5432`.
- **Dashboard:** `pnpm db:up && pnpm db:migrate`. Then build contracts, api and web (`pnpm --filter @personal-api/contracts build`, `pnpm --filter api build`, `pnpm --filter web build`) and start the API in the background (`pnpm --filter api start`), which serves the dashboard. Wait for `GET /healthz` to return 200, then open `http://localhost:3000`.
- **Extension:**
  - Firefox (primary): `pnpm --filter extension dev:firefox` opens Firefox with the extension loaded.
  - Edge: `pnpm --filter extension dev`, then load `.output/chrome-mv3` unpacked.
- When the user is done (or asks you to stop everything), stop the background tasks. Kill any leftover `node`/`wxt` processes still listening (`netstat -ano | grep LISTEN`), checking each command line before killing it. Then run `pnpm db:down`.

## 9. Windows gotchas (this machine)

- PowerShell drops a bare `--` passed to native commands. Use `claude mcp add-json …`, or quote `'--'`.
- Git Bash rewrites `/c` in arguments into `C:/`. Run `cmd /c …` from PowerShell.
- Stopping a background task can leave its child `node.exe` running and holding its port. Check, and kill it by PID.
- fnm puts Node on PATH only per shell. Anything Claude Code starts on its own (MCP servers) needs the absolute `npx.cmd` path.

## 10. Report

Keep it short:
- the task and the PR link
- check results (with counts)
- what wasn't verified locally
- follow-ups
- **the merge command(s)**
- **the next step:** the next unticked task ID with its tag, and the `/model` to switch to (for example "next: `/model sonnet` then `/task M4-01` [S · high]")

The user prefers light ceremony. Watch the context limit in `CLAUDE.md` (stop at 40%, hand off).
