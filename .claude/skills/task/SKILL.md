---
name: task
description: Run one Personal API task from docs/PLAN.md end to end (for example "/task M1-05"). The session reads the project docs first, then implements and tests the task itself, with no per-task subagents. Only Mx-R reviews launch a reviewer subagent. Use when the user asks to do, run or implement a task ID such as M0-03 or M2-R.
argument-hint: <task-id> [auto-merge]
---

# /task: run one plan task inline

You do the work yourself in this session: no `builder`, `test-writer` or other subagent per task. Only `Mx-R` launches a subagent (`reviewer`, Opus). DeepSeek and `opencode-delegate` are not used; ignore any leftover `{deepseek}` marker. Arguments: `$ARGUMENTS`, a task ID such as `M1-05` or `M1-R`, optionally followed by `auto-merge`.

## 1. Look up the task

- Find the line `- [ ] **<ID> [<M> · <effort>] …**` in `docs/PLAN.md` §10.
- If the box is already ticked, or the ID is missing, stop and tell the user.
- If an earlier task in the same milestone is still unticked, warn the user and ask before continuing. Tasks are ordered on purpose.

## 2. Read everything first (no code before this is done)

1. `CLAUDE.md` in full (invariants, conventions, gotchas).
2. The task line and its "done when" criteria, plus every other `docs/PLAN.md` section it relies on (architecture, data model, API, rule format).
3. The ADRs in `docs/adr/` that touch the area.
4. The existing code and tests beside the files you will change, and the contracts in `packages/contracts` you will use.

Then give the user two or three lines: what you will build and anything the plan leaves open. If the plan is missing something the task needs, or code and plan disagree, **stop and ask**. Don't invent API surface (routes, DTOs, formats) on your own.

## 3. Prepare the branch

`git switch main && git pull --ff-only`, then `git switch -c <id-lowercase>-<short-name>`. `Mx-R` tasks get no branch (step 7).

## 4. Implement and test

- Write the tests from the "done when" criteria. On `high`/`xhigh`/security-touching tasks, write them first and watch them fail for the right reason. A new route also gets a cross-tenant test (and an entry in the cross-tenant sweep).
- Then implement until they pass. Never weaken a test to get green.
- Follow the conventions and invariants in `CLAUDE.md`. Add dependencies only when the plan names them.
- Auth, tenant scoping, key handling or an invariant question you can't settle from the docs: stop and tell the user with the evidence.

## 5. Verify (never trust "done" alone)

Run and read the output: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:int` if you touched the DB or added routes and Docker is running. If Docker is off, say that integration and e2e only run in CI. Don't claim they passed.

## 6. Ship

1. Tick the task's box in `docs/PLAN.md` on the branch. Commit (Conventional Commits, with the attribution trailer Claude Code gives you).
2. Push and open a PR to `main`: task ID, summary, checks run, anything not run locally.
3. `gh pr checks --watch`. If CI fails, read the log and fix it. A failure outside your diff: report it, don't paper over it.
4. Merge: without `auto-merge`, give the user the `gh pr merge <n> --squash --delete-branch` command and wait for approval. With `auto-merge`, merge only when CI is green.

## 7. `Mx-R` review tasks

No branch. Launch one `reviewer` subagent (`model: opus`, the tagged effort) over every commit merged for milestone Mx, with pointers to `CLAUDE.md` and `docs/PLAN.md`. Report blockers and should-fix findings to the user and offer fix tasks; don't fix them silently. On `approve`, tick `Mx-R`.

## 8. Report

Short: the task, the PR link, check results, what wasn't verified locally, follow-ups. The user prefers light ceremony.
