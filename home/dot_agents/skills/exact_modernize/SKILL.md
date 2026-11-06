---
name: modernize
description: >-
  For getting old prs up to date. Use when asked to rebase a pr or
  "modernize".
---

# Modernize

Modernize the idea, not just the branch. A clean rebase does not prove that the
PR still belongs in the product.

## Guardrails

- Always check to make sure you have pulled latest origin for your branch, main
  branch, and any other branch related to your work before starting.
- Treat existing worktree changes as user-owned. When the active worktree is dirty or is being used for other work: inside T3, use a T3 worktree: `delegate_task` with `isolation: "worktree"`, then fetch and check out the PR head inside it, never a manual `git worktree add`; outside T3, use a disposable git worktree. Conflict resolution beyond a small fix goes to an Opus builder when you are not Opus (`subagent-routing`).
- Modernizing authorizes rebasing, the local gate, and landing a `MODERNIZE`
  PR with `land-pr`. Not closing, a new base, or wider scope. Update-only asks stop at ready.
- Never use an unqualified force push. Update a rebased branch with
  `--force-with-lease` against the head SHA observed before the rebase.
- Do not post a PR comment unless the user asked for one. Use the
  `leaving-pr-comments` skill for every comment posted on the user's behalf.

## Establish the PR's intent

Resolve the PR: URL, state, base, head branch and SHA, author, review state.
Read title, body, linked issues, commits, threads, full diff. State its
smallest coherent goal before judging the implementation.

Fetch the latest remote base and PR head. Use the PR's actual base branch,
usually `main`, rather than assuming the local branch is current. Record the
merge base so the original PR and subsequent base-branch changes can be
compared separately.

## Check what changed around it

Inspect commits and diffs added to the base branch since the PR diverged. Search
merged and open PRs when titles, code paths, or behavior suggest a replacement
or competing implementation.

Look beyond overlapping lines:

- Has the same user-facing problem already been solved?
- Did APIs, types, schemas, dependencies, or architectural boundaries change?
- Do both sides now claim ownership of the same behavior or invariant?
- Was the code being changed deleted, moved, or intentionally simplified?
- Would landing the PR restore an old behavior or create two ways to do the
  same thing?
- Is the original benefit still large enough to justify the maintenance cost?

Do not describe a PR as current merely because Git reports no conflicts.

## Choose a disposition before pushing

Use one of these recommendations:

- **MODERNIZE**: the goal is still useful and the implementation remains the
  right shape. Rebase, resolve conflicts, run the local gate, then land it.
- **REWORK**: the goal is still useful, but a mechanical rebase would preserve
  the wrong implementation. Explain the smallest credible rewrite and stop
  before pushing unless the user also asked for that rework.
- **CLOSE**: the PR is superseded, obsolete, directionally wrong, or no longer
  worth its cost. Cite concrete evidence and stop. Do not spend time rebasing an
  obsolete branch, and do not close it without explicit permission.

Be willing to recommend `CLOSE`. Age alone is not evidence, and sunk effort is
not a reason to keep a PR alive.

## Rebase without losing intent

For a `MODERNIZE` disposition:

1. Create a safe local branch, or a T3 worktree (see Guardrails), at the recorded PR head.
2. Rebase its commits onto the freshly fetched base branch.
3. Resolve each conflict according to the PR's current intent and the base
   branch's newer invariants. If a conflict reveals a product or architecture
   disagreement, stop and reconsider the disposition instead of guessing.
4. Compare the pre-rebase and post-rebase commit series with `git range-diff`
   and inspect the final diff. Confirm that no intentional behavior disappeared
   and no already-landed behavior was reintroduced.
5. Run the local gate on the rebased head (see `pr-workflow`): lint, typecheck,
   build, reached tests and specs, CodeRabbit CLI once where present, the cross-family review `subagent-routing` sets, via `delegate_task` in T3. Fix every Critical, Major, P0, P1; rerun.
6. If the PR carries a queue label, follow "Editing a queued PR" in `pr-workflow` section 4 (never push while `landing`; otherwise `queue-hold` first). Push with `--force-with-lease` tied to the previously observed remote head. In T3, call `link_pull_request` with the full URL right after the push.
   If the lease fails, fetch and reassess rather than overwriting new work.
7. Land it with `land-pr <n> --sha <gated sha>` and follow `pr-workflow`
   section 4 for the outcome, the lander kick and the fallback. No `--auto`,
   GitHub merge queue, or `--admin`. Clean up (`pr-workflow` §7) only after
   it merges.

## Report

Lead with `MODERNIZE`, `REWORK`, or `CLOSE` and the reason. Then summarize:

- meaningful base changes; conceptual conflicts, or none found;
- rebase, push and landing result (the `land-pr` outcome), if performed; checks and results;
- the remaining decision or work, with a link to the PR.

Separate observed facts from judgment. Say what could not be verified instead
of manufacturing confidence.
