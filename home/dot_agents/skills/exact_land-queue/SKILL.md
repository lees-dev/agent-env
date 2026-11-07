---
name: land-queue
description: The lander. Run by each repo's T3 `land-queue` schedule (or `run_scheduled_task_now` after a builder sees QUEUED or QUEUE-FULL) to land queued PRs with `land-queue run`, route bounces to a fixer, and report counts. Use when asked to run, kick, check or fix a repo's land queue.
---

# Land queue (the lander)

You are the repo's lander. The landing rules live in the `pr-workflow` skill, section 4 ("Open and land", "The land queue", "Editing a queued PR"); where this skill and that section differ, section 4 wins. This skill is how the lander carries them out. The work is mechanical: do not edit code yourself, do not merge by any other means, and do not change labels the script owns.

## 1. Run it

```sh
node "$HOME/.agents/bin/land-queue.mjs" run --json            # this repo (run from its checkout)
node "$HOME/.agents/bin/land-queue.mjs" run --all --json      # every repo in ~/.agents/state/repos.json
```

The script works one repo at a time, one PR at a time, under the repo lock (`refs/heads/agent-landing-lock`):

- stops when the repo is paused (`AGENT_LANDING_PAUSED=1`);
- first, under the lock, resets any leftover `landing` PR (a crashed run) to `queued`, keeping `queue-hold`, even when the repo is paused or nothing else is eligible;
- takes the lock for each PR; under it, admits the oldest `queue-waiting` PRs while the unheld `queued` + `landing` PRs are fewer than `maxQueued` in `.agents/repo.json` (default 5; a waiting PR whose head moved is bounced; held PRs use no capacity);
- order: `queue-next`, then `Linear-Priority:` (1 Urgent, 2 High, 3 Medium, 4 Low; 0 or missing = 3; ascending), then time queued; skips `queue-hold` and unmerged `Depends-on: #n`;
- checks the head still equals the gated sha and that the PR still targets the base its gate ran against (`Gate: pass @ <sha> base=<branch>`, written by `land-pr`): a line without a base, or a PR now on another base, bounces for a new gate and review on the PR's base and a fresh `land-pr`; bounces a branch that needs a rebase and has merge commits (a plain rebase would drop a change made only in a merge: rebase it by hand, re-gate, re-review); rebases in `<main checkout>-lander`, and treats the rebase as unchanged only when every commit is `=` in `git range-diff <base_old>..<gated> <base_new>..<rebased>`, there was no conflict, and the rebased diff touches no new path;
- runs the repo's `setup` and `affectedGate` (one retry; a repo with no gate lands nothing; the lander checkout keeps git-ignored files such as dependencies and build output between PRs, so setup and the gate must rebuild every output the gate reads; a gate must stop every process it starts before it exits, since the lander only stops what a command started when it times out or loses the lock; a command running longer than `commandTimeoutMin` in `.agents/repo.json`, default 60, is stopped with every process it started and bounces without a retry); re-checks the PR (same base and head branch, every `Depends-on` merged, then labels, head, pause flag and that the lock is still its own); pushes `--force-with-lease`; appends `Gate: pass @ <newsha> (lander rebase) base=<branch>` (the base it rebased onto and gated against); re-checks base, branch and `Depends-on`; refetches and requires `git merge-base --is-ancestor origin/<base> <newsha>` (if the base moved it redoes the rebase and validation, at most three times, then bounces); re-reads labels, head, pause and the lock last; merges `--match-head-commit <newsha>`; clears the queue labels;
- on an abort (hold, pause, retarget, new `Depends-on`, head change, crash) puts `queued` back, keeping `queue-hold`; the next round validates it again. Two cases leave `landing` instead: a lost lock (the next lander's recovery resets it) and a landing step that timed out with the lock kept (`lockRetained`: stop that step's processes first, then follow the lockRetained instructions below);
- anything else bounces the PR to `queue-blocked` with one comment and a `Bounced:` line (the attempt number). The comment and the report name the command, its exit status or timeout, and the paths or SHAs involved; command output is never posted (it can hold secrets), so the fixer reruns the command in its worktree; the third bounce, after two automatic fix attempts, posts a comment starting `PARKED:`;
- every `sweepEveryMerges` merges (its own or `land-pr`'s) runs the repo's wide sweep on the base under the lock, also when it is idle and a sweep is overdue; red sets the repo pause.

`land-queue status --json` looks without changing anything; `run --dry-run --json` shows the plan.

## 2. Act on the report

Each repo report has `merged`, `bounced` (with `attempt` and `parked`), `aborted`, `admitted`, `reset`, `queued`, `held`, `waiting`, `queueWaiting`, `stale`, `busy`, `paused`, `alerts`, `sweep`, `drafts`, `plan` (a dry run only), `error` (when the run stopped on an error), and `lockRetained` when the lock could not be released.

- **merged**: mark each PR's Linear ticket Done with the merge sha; clean up per `pr-workflow` section 7 (worktree teardown does most of it).
- **bounced**, not parked: move the Linear ticket back to In Progress with the reason. Start an Opus fixer (`subagent-routing`): in this project `delegate_task` with `isolation: "worktree"`; for another repo `t3_thread_launch` with a worktree. Brief it with the PR, the bounce reason, and `pr-workflow` "Editing a queued PR":
  1. `node "$HOME/.agents/bin/land-pr.mjs" hold <n> --holder <id>` with one fixed id for this fix (the fixer's `$T3CODE_THREAD_ID` is used when `--holder` is left out; with neither it refuses). It adds `queue-hold` and `Hold-By: <id> <ISO time> events>N` (N: the PR's newest event id, so the release can find this hold's label event) under the landing lock. On a PR already held it joins (`HELD <id> (joined)`): only its line is added and the label stays until the last holder releases. It refuses if the PR is `landing`, this id already holds it, or the lock is busy: then report, and retry only for a busy lock once the lander is done;
  2. fix on the PR branch, push, run the affected gate;
  3. one cross-family reviewer checks the fix (for a conflict, the resolution), started the same way;
  4. `node "$HOME/.agents/bin/land-pr.mjs" <n> --sha <new gated sha> --release-hold --holder <the same id>` (checks first, then records the new gated sha and removes only its own hold, in one edit; the PR goes back in line). A `REFUSED` that ends "your hold was already released and the gated sha recorded" found a reason (a pause, a landing, an unmerged `Depends-on`, a sweep that is not green) after the release: the release stands and nothing is rolled back; run plain `land-pr <n> --sha <sha>` once the reason clears.
  If no fixer can be started, report that for `full-send` or the owner.
- **bounced** and **parked** (`PARKED:` comment posted): start no fixer. Note it on the Linear ticket; `full-send` and the owner act on it.
- **aborted**: `queue-hold`, a pause, a retarget, a new `Depends-on`, a pushed head or a lost lock appeared mid-landing. Usually nothing to do: the PR is `queued` again and the next run validates it again. If the report also has `lockRetained` (a rebase, push or merge command timed out), the PR stays `landing` and the lock is kept: handle it as **lockRetained** below (stop the step's processes first). A lost lock wins over every other reason: the lander changes nothing more (no label, bounce or checkout reset), leaves `landing` for the next lander's recovery, and stops the run: report it.
- **reset**: a crashed run left `landing`; it is `queued` again. Mention it.
- **drafts**: queued PRs that are drafts; the lander skips them and changes nothing. Mention them: once the PR is marked ready it lands in its turn.
- **plan**: a dry run's landing order (PR numbers); nothing was changed. Report it.
- **stale**: the lock is older than its ttl. Confirm the holder (`host`, `pid`) is gone: same machine, no such process, no lander thread running. Only then rerun with `--reclaim-stale`. Otherwise report it. Only the lander reclaims a stale lock.
- **busy**: another lander holds the lock. Stop; the next run picks up.
- **lockRetained**: this run did not delete its own lock (the alert says why and gives the command). A landing step that runs repo code (the rebase, the push with its pre-push hook, the merge command) and timed out, or a git transfer that timed out, keeps it: the step may still be running; nothing was reset or relabelled. Report it; it blocks every lander until it is deleted, or reclaimed as stale once its ttl has passed. When the alert says a command could not be stopped, first make sure that command and everything it started (in the lander checkout) have stopped; then delete the lock with that command, and only while no lander run is active.
- **paused** or a sweep alert: open a ticket for the red sweep on the base, with the failing command and the alert. Land nothing. When a fix is on the base, `node "$HOME/.agents/bin/land-queue.mjs" unpause` takes the landing lock (it refuses while another lander holds it), reruns the sweep and clears the pause only when it is green; a repo without a `wideSweep` keeps the pause for the owner to clear.
- **error** on a repo: report the message; do not retry in a loop. The run stopped at the error, but everything the report lists before it stands: handle its merged, bounced and aborted PRs as usual.

## 3. Labels

| Label | Set by | Cleared by |
| --- | --- | --- |
| `queued` | `land-pr`; the lander (admitting a `queue-waiting` PR, or after an abort) | the lander, `full-stop` |
| `landing` | the lander | the lander |
| `queue-blocked` | the lander | the lander, or `land-pr` re-landing it |
| `queue-hold` | only `land-pr hold <n> --holder <id>`: the owner `--holder owner`, `full-stop` `--holder full-stop`, an agent its thread id | the last holder's `--release-hold` (each release removes only its own line); the owner may remove it by hand |
| `queue-next` | the owner | the owner (`full-stop` may remove it only while setting `queue-hold`) |
| `queue-waiting` | `land-pr` | the lander (admission), `land-pr`, `full-stop` |

Never add `queue-hold` by hand: agents and the owner share one gh identity, so a hand-set label cannot be told from a hold's, and a holder's release may remove it. Hold with `land-pr hold` instead. A release whose hold has no proven label origin keeps the label and says so: the owner removes it by hand. Never remove a `queue-hold` you did not set (the owner may remove any deliberately), never add `queue-next`, never `gh pr merge` a PR with a queue label.

## 4. Report

One line per repo, counts only: merged, bounced (fixers started, parked), aborted, reset, admitted, still queued, waiting for room, held, and any stale lock, pause or alert. No secrets, no log dumps.
