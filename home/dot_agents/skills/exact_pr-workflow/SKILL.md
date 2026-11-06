---
name: pr-workflow
description: Local-gate pull-request workflow for any repository. Every check runs locally before the PR opens; open the PR, then land it with land-pr (merges now or queues it for the repo's lander). Use before briefing an agent to build a PR, before opening a PR, pushing to a PR branch, updating or rebasing it, reviewing it, landing or merging it, or cleaning up after it merges.
---

# PR workflow

**The repo supplies facts, not process.** Read its `AGENTS.md` / `CLAUDE.md`, `docs/agents/repo.md`, `.agents/repo.json`, `CONTRIBUTING`, PR template and gate docs first. They supply facts (gate, sensitive paths, size limit, merge method and identity, release step, per-worktree resources) and may add stricter checks; they never override process (CI waits, merge queues, agent tooling, worktrees, cleanup, credentials, landing). See the repo-defaults rules.

The leading idea: **no CI**. Every check runs locally on the committed head before the PR opens. Open the PR once, then land it with `land-pr`: it merges now or queues the PR for the repo's single lander (section 4). An open PR that has no `land-pr` outcome is a step missed.

## 1. Discover the repo's local gate

1. Read `AGENTS.md` / `CLAUDE.md` for the gate commands. Then check `package.json` scripts, `Makefile`, and `scripts/`.
2. Name the exact commands for: lint, typecheck, build, tests, and browser/E2E specs.
3. Prefer the repo's single gate or affected-tests command when it has one (for example `npm run gate`). Otherwise use its full test command.
4. Note which OS the tests assume. When the old CI ran on Linux and this host is Windows, run the gate in a WSL clone with its own install (never share `node_modules` across the boundary).
5. Note the merge method (check recent merged PRs) and any release step after merge.

Done when you can list the exact local gate commands, the merge method, and the release step.

## 2. Ready before it opens

Run everything on the committed head. Fix, recommit, and rerun until clean. Full procedure: [`references/ready-to-merge.md`](references/ready-to-merge.md).

1. **Local gate.** Run lint, typecheck, build and the unit tests the change reaches. Run only the browser/E2E specs the change adds or edits. Wide browser sweeps run on main every few merges (the repo's full mode), not before each PR.
2. **CodeRabbit CLI**, once, when the repo has `.coderabbit.yaml`: `coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"`. It runs on Linux/macOS only. From Windows, run it in WSL from a clone whose `origin` is the GitHub URL.
3. **Cross-family review**, as `subagent-routing` sets it, started with `delegate_task` in T3: one focused cross-family reviewer by default (GPT Sol for Claude-built work, Opus for GPT-built work), whatever the change's line or file count, plus a second family when it touches security, auth, data loss, migrations, or concurrency; the four-model review panel (GPT Sol, Muse Wonder Full, Grok 4.7, Sonnet) only for complex new behavior or a sensitive path in Opus-built work. Fixes beyond a small fix go to an Opus builder.
4. **Fix** every Critical, Major, P0, and P1. Rerun the gate and the reviews that found them.

Brief every builder (you, or a `delegate_task` child) with the repo's rules for the paths it will touch: `.coderabbit.yaml` path instructions, the pre-push checklist, size limit, and sensitive paths.

Done when the gate, the CodeRabbit run (where present), and the cross-family review are clean on the commit you will push.

## 3. Pre-open checklist

- [ ] The local gate passed on the committed head: lint, typecheck, build, affected unit tests, and the browser/E2E specs the change adds or edits.
- [ ] CodeRabbit CLI (where present) and cross-family review are clean. No Critical, Major, P0, or P1 remains.
- [ ] The diff covers one issue/ticket and stays within the repo's size limit.
- [ ] Title, body, and attachments hold no secrets or private content. The body records the local results.
- [ ] The branch is based on the current base branch.
- [ ] The body has a `Linear-Priority: <0-4>` line (the ticket's Linear priority) and `Depends-on: #n` for any PR this one needs merged first.

## 4. Open and land

This section is the one home of the landing rules. Every other skill, doc and hook points here.

0. **Check the lander exists.** `list_scheduled_tasks` shows the repo's `land-queue` schedule, and `~/.agents/bin/land-pr.mjs` exists. If either is missing, do not run `land-pr` (it could queue the PR with nobody to drain it): use the fallback below.
1. Push once. Open the PR ready (not draft), with the template and the local results in the body. In T3, call `link_pull_request` with the full URL as your next call (`link_pull_requests` for a stack).
2. Land it, pinned to the commit the checks ran on: `land-pr <n> --sha <gated sha>` (`node ~/.agents/bin/land-pr.mjs`). Use no `--auto`, no GitHub merge queue, no `--admin`. Wait on no CI. It prints one outcome:

   | Outcome | What happened | Next |
   | --- | --- | --- |
   | `MERGED <sha>` | Merged now. | Clean up (section 7). |
   | `QUEUED <pos>` | Labelled `queued`; `Gate: pass @ <sha>` recorded in the body's `## Landing` section. | Kick the lander (step 3). |
   | `QUEUE-FULL <pos>` (exit 3) | The queue is full; labelled `queue-waiting`. The lander admits it when room frees. | Kick the lander (step 3). |
   | `REFUSED <reason>` (exit 2) | Nothing merged, no label changed. Reasons: `queue-hold`, `landing`, an unmerged `Depends-on: #n`, or the repo is paused (`AGENT_LANDING_PAUSED`). | Report it. Do not work around it. |

   It merges now only when no PR in the repo is `queued`, `queue-waiting` or `landing` (fairness); otherwise it queues. The merge-now path: it takes the repo lock atomically first, then fetches, rechecks `git merge-base --is-ancestor origin/<base> <sha>` and the labels, head and pause flag, merges with the repo's merge script or identity (`mergeCmd` / `ghWrapper` in `.agents/repo.json`, for example a GitHub App identity) or `gh pr merge <n> --<method> --delete-branch --match-head-commit <sha>`, confirms `MERGED`, and releases only its own lock. A busy lock or a moved base means it queues instead. On a PR that is already `queued` or `queue-waiting` it only refreshes the gated sha (it never merges now). Only the lander reclaims a stale lock, after confirming the holder is gone; anyone else who sees a stale lock reports it.
3. **Kick.** The agent that sees `QUEUED` or `QUEUE-FULL` calls `run_scheduled_task_now` for the repo's lander schedule (`land-queue`), if one exists (`list_scheduled_tasks`).
4. **Done.** A PR is done when it is `MERGED`. A builder's hand-off is complete at `QUEUED` or `QUEUE-FULL` with the PR linked and the Linear ticket left open (the lander finishes it). `full-send`, and `babysit-pr` when asked to land, are done only at `MERGED`: `watch_pull_request`, end the turn, and `unwatch_pull_request` before handback.
5. Production stays behind the repo's release step. Promote to production only with the owner's explicit approval.

**Fallback.** If `~/.agents/bin/land-pr.mjs` is missing, or the repo has no lander schedule yet (step 0): hand-merge one PR at a time, with the repo's merge script or identity (or `gh pr merge <n> --<method> --delete-branch --match-head-commit <sha>`), and only when all of these hold:

- the repo is not paused: `AGENT_LANDING_PAUSED` is not `1` (`gh api repos/<o>/<r>/actions/variables/AGENT_LANDING_PAUSED`; not found = not paused);
- every `Depends-on: #n` in the PR body is merged;
- the PR carries no queue label (`queued`, `landing`, `queue-blocked`, `queue-hold`, `queue-next`, `queue-waiting`);
- `<sha>` is the commit the gate and review passed on (`Gate: pass @ <sha>` in the PR body).

Immediately before merging, refetch and recheck `git merge-base --is-ancestor origin/<base> <sha>` (`--match-head-commit` pins the head, not the base); if the base moved, rebase, rerun the affected checks and reviews, push, record `Gate: pass @ <new sha>`, and check everything again. If any other condition fails, stop and report; never work around it. Report "fallback used".

### The land queue

Each repo has one lander: a T3 `schedule_task` named `land-queue` that runs `land-queue run`. Builders keep building in parallel.

| Label | Meaning | Set by | Cleared by |
| --- | --- | --- | --- |
| `queued` | Waiting in line. | `land-pr`; the lander (admitting a `queue-waiting` PR) | the lander, `full-stop` |
| `landing` | The lander has it now. | the lander | the lander (on any abort it goes back to `queued`) |
| `queue-blocked` | Bounced; needs a fix and a re-land. | the lander | the lander, or a `land-pr` re-land |
| `queue-hold` | Skip it. | the owner, `full-stop`, or an agent editing a queued PR (below) | only whoever set it; the owner may clear any |
| `queue-next` | Jump the line. | the owner | the owner (`full-stop` may remove it only while setting `queue-hold`; the owner restores it) |
| `queue-waiting` | Ready, but the queue was full. | `land-pr` | the lander (admission), `land-pr`, or `full-stop` |

- **Capacity:** `queued` + `landing` ≤ 5 per repo. `queue-blocked`, `queue-hold` and `queue-waiting` do not count.
- **Repo pause:** the repo variable `AGENT_LANDING_PAUSED=1` (`gh api repos/<o>/<r>/actions/variables`), not a label. A red wide sweep sets it; the fix that turns the sweep green, or the owner, clears it. While it is set, `land-pr` and the lander merge nothing.
- **Order:** `queue-next`, then `Linear-Priority:` (1 Urgent, 2 High, 3 Medium, 4 Low; 0 or missing = 3; ascending), then time queued. A PR with an unmerged `Depends-on: #n` waits.
- **The lander**, one PR at a time under the repo lock: checks the head still equals the gated sha, rebases in its own checkout, and re-reads labels, head and pause flag right before its force-push and again right before the merge, aborting on any change. The rebase is unchanged when every commit is `=` in `git range-diff <base_old>..<gated> <base_new>..<rebased>`, there were no conflicts, and the rebased diff touches no new paths. Then it runs the affected gate, pushes with `--force-with-lease`, appends `Gate: pass @ <newsha> (lander rebase)`, refetches and requires `git merge-base --is-ancestor origin/<base> <newsha>` (if the base moved, it redoes the rebase and validation, or bounces), merges `--match-head-commit <newsha>`, and marks the Linear ticket Done. Anything else bounces for re-gate and re-review. On any abort (hold, pause, head change, crash) it puts `queued` back (keeping `queue-hold` if present) and never leaves `landing` behind; each run starts by resetting a stale `landing` PR to `queued`. Every few merges it runs the repo's wide sweep on main; red sets the repo pause and opens a ticket.
- **Bounce:** a changed head, a changed rebase, a conflict or a red gate moves the PR to `queue-blocked` with one comment giving the reason. An Opus fixer fixes it (in this project use `delegate_task` with `isolation: "worktree"`; for another repo use `t3_thread_launch` per `subagent-routing`), one cross-family reviewer checks the fix (started the same way), and it goes back through `land-pr` with the new gated sha, following "Editing a queued PR". **Parked:** once two lander attempts are used, the PR stays `queue-blocked` and the lander posts a comment starting `PARKED:`. `full-send` and the owner act on a PARKED PR, or when the lander reports it cannot start a fixer.

**Editing a queued PR** (`babysit-pr`, `modernize`, `takeover`, `full-send` fixes, a builder's follow-up push), for a PR labelled `queued`, `queue-next`, `queue-waiting`, `queue-blocked` or `landing`:

- `landing`: never push. Wait for its merge or bounce.
- `queue-hold` already present (the owner, `full-stop` or someone else set it): leave it, push nothing that lands, and report it.
- Otherwise: take your own hold with `land-pr hold <n> --holder <id>` (it adds `queue-hold` and a `Hold-By:` line; use `$T3CODE_THREAD_ID` as the id in T3, otherwise one fixed id for this task, and the same id on every call), confirm there is no `landing` (if you find `landing` while holding your own hold, release it and wait), push, run the affected gate and the review of the new range, then `land-pr <n> --sha <new gated sha> --release-hold --holder <id>` (it refreshes the gated sha and removes only your own hold, in one step).
- The lander clears `landing`, `queued`, `queue-waiting` and `queue-next` from a PR it merges.

Done when `land-pr` printed `MERGED <sha>` (or `gh pr view <n> --json state` reports `MERGED`), or a builder handed back at `QUEUED` / `QUEUE-FULL` with the lander kicked, or `REFUSED <reason>` was reported.

## 5. A repo that still has CI

1. Treat existing CI as advisory. Never wait on it. Never add to it.
2. Next time work happens in that repo, tell the owner. Then open a separate, small PR that deletes the PR/merge CI workflows and required checks, keeps release/deploy workflows, and adds a single local gate command. Run that PR through this same workflow. If that repo's required checks block the removal PR, let them run that one time (in T3: `watch_pull_request`, end the turn, and `unwatch_pull_request` before handback; never `gh pr checks --watch` or sleep loops) or ask the owner to lift them; never `--admin` without the owner's go-ahead.

Done when the owner has been told and the removal PR is filed or merged.

## 6. Report what ran

Report: the PR link and the `land-pr` outcome (`MERGED <sha>`, `QUEUED <pos>`, `QUEUE-FULL <pos>` or `REFUSED <reason>`), plus "fallback used" when section 4's fallback merged it; each check and review that ran, with its result; anything not run, and why.

## 7. Clean up once it merges

At hand-off, even when the PR is only `QUEUED`, stop what this session started: PR watches it set (`unwatch_pull_request`), delegate runs (`task_cancel`), preview tabs (`t3_preview_close`), monitors and background shells. Everything else waits for the merge: only after the PR has merged (or closed for good), remove everything the work created. Leftovers pile up across sessions, fill disks and confuse the next agent.

1. **Confirm first.** For each item, check:
   - the PR is `MERGED` or `CLOSED` (`gh pr view <n> --json state`);
   - the item holds no uncommitted or unpushed work: `git -C <wt> status --porcelain --untracked-files=all` is empty, and HEAD counts as pushed: it equals the PR head, OR its sha appears in a `Gate: pass @ <sha>` line of the PR body, OR `git range-diff` shows the same patches as the merged PR head, OR `git -C <wt> rev-list HEAD --not --remotes` is empty (after a squash merge, `origin/main..HEAD` is never empty, so do not use it);
   - the PR carries no queue label (`queued`, `landing`, `queue-blocked`, `queue-hold`, `queue-waiting`): never remove its worktree while it does;
   - no other open PR, stacked branch or running job uses it.

   In T3, the `agent-worktree` engine does this automatically: `agent-worktree teardown` runs when a thread settles, and `agent-worktree sweep` finishes what is left. Read what it kept and why (`agent-worktree status`) before removing anything by hand.
2. **Remove**, wherever the work ran (this machine, a server, a VM, a container host):
   - **Worktrees and branches:** in T3, list them with `t3_worktree_list`; then `git worktree remove <wt>` and `git worktree prune` (T3 has no remove tool). Delete the local branch, and the remote head branch if the repo doesn't auto-delete it (`gh api -X DELETE repos/<o>/<r>/git/refs/heads/<branch>`). Also delete helper refs such as `prove/*` or `cr/*` in bare or server repos.
   - **Server checkouts:** proof dirs, review dirs and clones made for this PR.
   - **Data:** test databases, schemas and users created for the PR; scratch volumes, buckets, Group Folders and tmp dirs; leftover containers and images from its test runs (`docker ps -a`, `docker volume ls` filtered by the label or name the tests use).
   - **Background work:** PR watches (`unwatch_pull_request`), delegate runs (`task_cancel`), scheduled tasks (`delete_scheduled_task`), preview tabs (`t3_preview_close`), watchers, monitors, background shells, `nohup`/`systemd-run` jobs.
3. **Never remove:** anything dirty or unpushed (report it instead); a worktree whose PR carries a queue label; shared caches, base images or the main checkout; anything a running job or another open PR uses; production data.
4. **Report** counts only: worktrees, branches, refs, server dirs, containers and volumes removed, plus anything kept and why.
