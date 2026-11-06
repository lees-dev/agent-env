---
name: land-queue
description: The lander. Run by each repo's T3 `land-queue` schedule (or `run_scheduled_task_now` after a builder sees QUEUED or QUEUE-FULL) to land queued PRs with `land-queue run`, route bounces to a fixer, and report counts. Use when asked to run, kick, check or fix a repo's land queue.
---

# Land queue (the lander)

You are the repo's lander. The landing rules live in the `pr-workflow` skill, section 4 ("Open and land", "The land queue", "Editing a queued PR"); where this skill and that section differ, section 4 wins. This skill is how the lander carries them out. The work is mechanical: do not edit code yourself, do not merge by any other means, and do not change labels the script owns.

## 1. Run it

```sh
node ~/.agents/bin/land-queue.mjs run --json            # this repo (run from its checkout)
node ~/.agents/bin/land-queue.mjs run --all --json      # every repo in ~/.agents/state/repos.json
```

The script works one repo at a time, one PR at a time, under the repo lock (`refs/heads/agent-landing-lock`):

- stops when the repo is paused (`AGENT_LANDING_PAUSED=1`);
- first, under the lock, resets any leftover `landing` PR (a crashed run) to `queued`, keeping `queue-hold`, even when the repo is paused or nothing else is eligible;
- admits the oldest `queue-waiting` PRs while the unheld `queued` + `landing` PRs are fewer than 5 (a waiting PR whose head moved is bounced; held PRs use no capacity);
- takes the lock for each PR;
- order: `queue-next`, then `Linear-Priority:` (1 Urgent, 2 High, 3 Medium, 4 Low; 0 or missing = 3; ascending), then time queued; skips `queue-hold` and unmerged `Depends-on: #n`;
- checks the head still equals the gated sha, rebases in `<main checkout>-lander`, and treats the rebase as unchanged only when every commit is `=` in `git range-diff <base_old>..<gated> <base_new>..<rebased>`, there was no conflict, and the rebased diff touches no new path;
- runs the repo's `affectedGate` (one retry; a repo with no gate lands nothing); re-checks the PR (same base and head branch, every `Depends-on` merged, then labels, head, pause flag and that the lock is still its own); pushes `--force-with-lease`; appends `Gate: pass @ <newsha> (lander rebase)`; re-checks base, branch and `Depends-on`; refetches and requires `git merge-base --is-ancestor origin/<base> <newsha>` (if the base moved it redoes the rebase and validation, at most three times, then bounces); re-reads labels, head, pause and the lock last; merges `--match-head-commit <newsha>`; clears the queue labels;
- on any abort (hold, pause, retarget, new `Depends-on`, head change, lost lock, crash) puts `queued` back, keeping `queue-hold`, and never leaves `landing` behind; the next round validates it again;
- anything else bounces the PR to `queue-blocked` with one comment and a `Bounced:` line (the attempt number); the third bounce, after two automatic fix attempts, posts a comment starting `PARKED:`;
- every `sweepEveryMerges` merges (its own or `land-pr`'s) runs the repo's wide sweep on the base under the lock, also when it is idle and a sweep is overdue; red sets the repo pause.

`land-queue status --json` looks without changing anything; `run --dry-run --json` shows the plan.

## 2. Act on the report

Each repo report has `merged`, `bounced` (with `attempt` and `parked`), `aborted`, `admitted`, `reset`, `queued`, `held`, `waiting`, `queueWaiting`, `stale`, `busy`, `paused`, `alerts`, `sweep`.

- **merged**: mark each PR's Linear ticket Done with the merge sha; clean up per `pr-workflow` section 7 (worktree teardown does most of it).
- **bounced**, not parked: move the Linear ticket back to In Progress with the reason. Start an Opus fixer (`subagent-routing`): in this project `delegate_task` with `isolation: "worktree"`; for another repo `t3_thread_launch` with a worktree. Brief it with the PR, the bounce reason, and `pr-workflow` "Editing a queued PR":
  1. `node ~/.agents/bin/land-pr.mjs hold <n> --holder <id>` with one fixed id for this fix (the fixer's `$T3CODE_THREAD_ID` is used when `--holder` is left out; with neither it refuses). It adds `queue-hold` and `Hold-By: <id> <ISO time>`, and refuses if `queue-hold` is already set or the PR is `landing`: then report and stop;
  2. fix on the PR branch, push, run the affected gate;
  3. one cross-family reviewer checks the fix (for a conflict, the resolution), started the same way;
  4. `node ~/.agents/bin/land-pr.mjs <n> --sha <new gated sha> --release-hold --holder <the same id>` (checks first, then records the new gated sha and removes only its own hold, in one edit; the PR goes back in line).
  If no fixer can be started, report that for `full-send` or the owner.
- **bounced** and **parked** (`PARKED:` comment posted): start no fixer. Note it on the Linear ticket; `full-send` and the owner act on it.
- **aborted**: `queue-hold`, a pause, a retarget, a new `Depends-on`, a pushed head or a lost lock appeared mid-landing. Nothing to do; the PR is `queued` again and the next run validates it again. A lost lock stops the run: report it.
- **reset**: a crashed run left `landing`; it is `queued` again. Mention it.
- **stale**: the lock is older than its ttl. Confirm the holder (`host`, `pid`) is gone: same machine, no such process, no lander thread running. Only then rerun with `--reclaim-stale`. Otherwise report it. Only the lander reclaims a stale lock.
- **busy**: another lander holds the lock. Stop; the next run picks up.
- **paused** or a sweep alert: open a ticket for the red sweep on the base, with the failing command and the alert. Land nothing. When a fix is on the base, `node ~/.agents/bin/land-queue.mjs unpause` takes the landing lock (it refuses while another lander holds it), reruns the sweep and clears the pause only when it is green; the owner may also clear it.
- **error** on a repo: report the message; do not retry in a loop.

## 3. Labels

| Label | Set by | Cleared by |
| --- | --- | --- |
| `queued` | `land-pr`; the lander (admitting a `queue-waiting` PR, or after an abort) | the lander, `full-stop` |
| `landing` | the lander | the lander |
| `queue-blocked` | the lander | the lander, or `land-pr` re-landing it |
| `queue-hold` | the owner, `full-stop`, or an agent editing a queued PR (`land-pr hold`) | only whoever set it (`--release-hold`); the owner may clear any |
| `queue-next` | the owner | the owner (`full-stop` may remove it only while setting `queue-hold`) |
| `queue-waiting` | `land-pr` | the lander (admission), `land-pr`, `full-stop` |

Never remove a `queue-hold` you did not set, never add `queue-next`, never `gh pr merge` a PR with a queue label.

## 4. Report

One line per repo, counts only: merged, bounced (fixers started, parked), aborted, reset, admitted, still queued, waiting for room, held, and any stale lock, pause or alert. No secrets, no log dumps.
