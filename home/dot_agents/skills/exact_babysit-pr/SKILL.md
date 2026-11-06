---
name: babysit-pr
description: Land an open pull request. Use when the user asks to monitor, watch, or babysit a PR.
---

# Babysit PR

In T3 Code, call `link_pull_request` on the PR first. Land it in this turn.
Call `watch_pull_request` only when something outside your control still
blocks the merge (a human review, a base that keeps moving): finish any rebase
and push first, then watch and end the turn. Call `unwatch_pull_request`
before you hand back. A delegated child never watches. Fixes beyond a small
fix go to an Opus builder through `delegate_task` when you are not Opus
(`subagent-routing`). Never wait with
`gh pr checks --watch`, `sleep` loops, `Monitor` or `ScheduleWakeup`.

There is no CI to babysit. Every check runs locally before a PR opens, and an
open PR is landed with `land-pr` (see `pr-workflow`). Land it:

1. **Check the PR.** Read its state, base, head, and diff (`gh pr view <n>`).
   Confirm the local results in its body cover the current head. Read any
   human review that requests changes. Note its land-queue label:
   `queued` / `queue-waiting` (in line; report its position from
   `land-queue status`), `landing` (the lander has it; never push),
   `queue-blocked` (read the lander's comment and fix it), `queue-hold` (a
   hold; do not land it unless the user asks).
2. **Bring it up to date.** Fetch the base. If the branch is behind or
   conflicts, rebase locally, rerun the affected local gate checks and
   reviews, push with `--force-with-lease`. A PR with a queue label is
   edited only per "Editing a queued PR" in `pr-workflow` section 4.
3. **Fix real findings.** Verify each finding against the source before
   changing code. Fix real bugs in the intended case. Decline the rest with a
   written reason (use `leaving-pr-comments`). Rerun the gate after each fix.
   Keep the PR at the size its goal needs.
4. **Land.** `land-pr <n> --sha <gated sha>`, then follow `pr-workflow`
   section 4 (outcomes, kicking the lander, the fallback). Use no `--auto`,
   no GitHub merge queue, no `--admin`. Land only when the user asked for
   it; otherwise report that the PR is ready. Never land while conflicted or
   carrying an open Critical, Major, P0, or P1. Asked to land, you are done
   only at `MERGED`: on `QUEUED` / `QUEUE-FULL`, `watch_pull_request` and
   end the turn. On `REFUSED <reason>`: report it and stop (do not watch).
5. **Clean up** after the merge. Follow `pr-workflow` section 7.

If an overlapping PR makes this one obsolete, stop, report it, and ask before
closing unless closure was authorized.

Rate limits: `gh pr view` uses GraphQL. When it is used up, read the PR via
REST: `gh api repos/<owner>/<repo>/pulls/<n>`.

Done when the PR is `MERGED` and cleanup is reported; when you were not
asked to land, when it is ready (or `REFUSED <reason>`) and reported.
