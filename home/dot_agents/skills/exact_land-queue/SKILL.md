---
name: land-queue
description: The lander. Run by each repo's T3 `land-queue` schedule (or `run_scheduled_task_now` after a builder sees QUEUED or QUEUE-FULL) to land queued PRs with `land-queue run`, route bounces to a fixer, and report counts. Use when asked to run, kick, check or fix a repo's land queue.
---

# Land queue (the lander)

You are the repo's lander. The landing rules live in the `pr-workflow` skill, section 4 ("Open and land" and "The land queue"); this skill is how the lander carries them out. Mechanical work: do not edit code yourself, do not merge by any other means, do not change labels the script owns.

## 1. Run it

```sh
node ~/.agents/bin/land-queue.mjs run --json            # this repo (run from its checkout)
node ~/.agents/bin/land-queue.mjs run --all --json      # every repo in ~/.agents/state/repos.json
```

The script works one repo at a time under the repo lock (`refs/heads/agent-landing-lock`) and one PR at a time:

- stops when the repo is paused (`AGENT_LANDING_PAUSED=1`);
- admits the oldest `queue-waiting` PRs while `queued` + `landing` < 5 (a waiting PR whose head moved is bounced);
- order: `queue-next`, then `Linear-Priority:` (1 Urgent .. 4 Low; 0 or missing = 3), then time queued; skips `queue-hold` and unmerged `Depends-on: #n`;
- checks head == gated sha, rebases in `<main checkout>-lander`, and treats the rebase as unchanged only when every commit is `=` in `git range-diff <base_old>..<gated> <base_new>..<rebased>`, there was no conflict, and the rebased diff touches no new path;
- runs the repo's `affectedGate` (one retry), re-reads labels, head and pause flag, pushes `--force-with-lease`, appends `Gate: pass @ <newsha> (lander rebase)`, re-reads them again, merges `--match-head-commit <newsha>`;
- anything else bounces the PR to `queue-blocked` with one comment and a `Bounced:` line (the attempt number);
- every `sweepEveryMerges` merges runs the repo's wide sweep on the base; red sets the repo pause.

Use `land-queue status --json` to look without changing anything, and `run --dry-run --json` for the plan.

## 2. Act on the report

Each repo report has `merged`, `bounced`, `aborted`, `admitted`, `queued`, `held`, `waiting`, `queueWaiting`, `stale`, `busy`, `paused`, `alerts`, `sweep`.

- **merged**: mark each PR's Linear ticket Done with the merge sha; clean up per `pr-workflow` section 7 (the worktree teardown does most of it).
- **bounced** with `attempt` 1 or 2: move the Linear ticket back to In Progress with the reason, then start an Opus fixer (`subagent-routing`): in this project `delegate_task` with `isolation: "worktree"`; for another repo `t3_thread_launch` with a worktree. Brief it with the PR, the bounce reason and `pr-workflow` "Editing a queued PR": add `queue-hold`, confirm no `landing`, fix on the PR branch, run the affected gate, get one cross-family review of the fix (for a conflict, of the resolution), remove `queue-hold`, then `land-pr <n> --sha <new gated sha>`. Never push to a PR labelled `landing`.
- **bounced** with `attempt` 3 or more: park it. Leave `queue-blocked`, comment that it needs the owner, note it on the Linear ticket. No more automatic fixers.
- **aborted**: `queue-hold` or a pause appeared mid-landing. Nothing to do; the PR stays `queued`.
- **stale**: the lock is older than its ttl. Check the holder (`host`, `pid`) is gone: same machine, no such process, no lander thread running. Only then rerun with `--reclaim-stale`. Otherwise report it.
- **busy**: another lander holds the lock. Stop; the next run picks up.
- **paused** or a sweep alert: open a LEE ticket for the red sweep on the base, with the failing command and the alert text. Do not land anything. When a fix is on the base, `node ~/.agents/bin/land-queue.mjs unpause` reruns the sweep and clears the pause only if it is green; the owner may also clear it.
- **error** on a repo: report the message; do not retry in a loop.

Never remove `queue-hold` (only whoever set it may; the owner may clear any), never add `queue-next` (owner only), never `gh pr merge` a PR with a queue label.

## 3. Report

One line per repo, counts only: merged, bounced (fixers started, parked), aborted, admitted, still queued, waiting for room, held, and any stale lock, pause or alert. No secrets, no log dumps.
