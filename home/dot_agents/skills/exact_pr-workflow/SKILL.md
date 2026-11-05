---
name: pr-workflow
description: Cost-aware pull-request workflow for any repository. Every PR opens already ready to merge. Use before briefing an agent to build a PR, before opening a PR, pushing to a PR branch, updating or rebasing it, reviewing it or answering review bots, fixing or re-running its CI, merging it, or cleaning up after it merges.
---

# PR workflow

**The repo's own rules win.** Read its `AGENTS.md` / `CLAUDE.md`, `CONTRIBUTING`, PR template and gate or CI docs first, and follow them wherever they differ from this skill.

The leading idea: **every push is a CI run**. Each push to a PR head re-runs the repo's PR workflows, and every job is billed (or holds a shared runner) for each started minute, whether it is working, waiting or sleeping. Cost model and sources: [`references/cost-model.md`](references/cost-model.md).

## 1. Discover the repo's CI (once per repo, before the first push)

```sh
grep -rn "runs-on" .github/workflows                       # which runners each job uses
grep -rnE "concurrency|cancel-in-progress|paths(-ignore)?:|types:|draft|merge_group" .github/workflows
gh run list --limit 10 --json workflowName,event,conclusion,createdAt,updatedAt,headBranch
gh run view <run-id> --json jobs --jq '.jobs[] | {name, conclusion, startedAt, completedAt}'
gh api rate_limit --jq .resources.core                     # REST quota is shared by every agent on this account
```

Read the `runs-on` labels:

| Label | Billing |
|---|---|
| `self-hosted` or a custom self-hosted label | free on GitHub (you pay for the machine) |
| `ubuntu-*`, `windows-*`, `macos-*` | GitHub-hosted: free on public repos, billed per minute on private repos past the plan's included amount |
| a size, `-large`, `*-core`, `gpu` | larger runner: billed per minute, at a higher rate, even on public repos |
| a vendor label (for example `blacksmith-*`, `namespace-*`, `buildjet-*`, `depot-*`, `warp-*`, `runs-on=…`) | third-party vendor: billed by the vendor (or your cloud account) on its own terms; read its pricing page |

Done when you can name the runner type of every job your change triggers, and whether draft PRs and docs-only changes skip CI.

## 2. Ready to merge before it opens

A PR opens only when it would pass every gate as it is. Review rounds after opening are the costliest part of a PR. Full procedure: [`references/ready-to-merge.md`](references/ready-to-merge.md).

1. **Collect the review rules** before anything is built:
   - the review bot's config (CodeRabbit: `.coderabbit.yaml` `path_instructions` and `pre_merge_checks`);
   - the gate script's exact command and blocking severity;
   - the repo's pre-push checklist.
2. **Brief every builder** (you, a subagent, a workflow agent) with those rules verbatim for the paths it will touch.
3. **Run the gate locally on the committed head.** Loop at most 3 rounds:
   - run the review bot's CLI with the gate's own flags (CodeRabbit: `coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"`, run on a Linux or macOS host if this one can't run it). Require **two independent clean runs** on the final head, because the review is non-deterministic;
   - run a cross-family model review;
   - fix every real Critical, Major, P0 or P1, recommit, and rerun.

   Then check the pre-merge checks (body size, Research section, privacy), the size limit and the base.
4. **Open once**, with the local review results in the PR's Validation section. A blocking finding that still appears after opening means the brief or the local gate missed a rule: fix the PR, then add that rule to the repo's checklist.

## 3. Pre-push checklist

- [ ] The repo's lint, typecheck and tests ran locally and pass (commands from its docs, `package.json` scripts, `Makefile` or `scripts/`).
- [ ] The local review gate (section 2) is clean on the commit being pushed.
- [ ] The diff covers one issue and stays small; refactors and formatting go in their own PR.
- [ ] Runner labels are unchanged: no new paid, larger or vendor runners; concurrency and path filters intact.
- [ ] Every fix made so far is in this one push: commit locally as often as you like, push once.
- [ ] Unfinished work opens as a draft (`gh pr create --draft`, then `gh pr ready`) when the repo's CI skips drafts.
- [ ] The push changes code or docs: CI never needs an empty commit or a "retrigger" push.

## 4. While the PR is open

- **Batch.** Collect review fixes and push them together, once the local checks pass again.
- **Update from the base only when needed**: a conflict, or a repo rule that branches be up to date. Do it once; leave catching up to the merge queue when the repo has one. Each rebase plus force-push is a full CI run.
- **Let concurrency work.** Keep `cancel-in-progress` in place; a newer push cancels the older run, so push only a commit you want tested.
- **Wait on events.** Use the repo's gates, auto-merge and notifications. When you must watch, use `gh pr checks <pr> --watch --interval 60` or `gh run watch <run-id> --interval 60` (defaults are 10 s and 3 s), and keep sleep or poll loops out of workflow jobs: a waiting job bills like a working one.
- **Review bots:** read the bot's latest review first, then send one command per real need and let it finish. Repeated commands queue repeated reviews.

## 5. When CI is red

1. Read the failing job's log: `gh run view <run-id> --log-failed` (or `--job <job-id> --log-failed`).
2. Name the cause. Reproduce it and fix it locally, and rerun that check locally until it passes.
3. Push once.
4. A flake (unrelated to your diff, passes locally, or a known flaky test): rerun only the failed jobs, once, with the reason stated in the PR: `gh run rerun <run-id> --failed`. Rerun the whole workflow only when every job needs it.

Done when the cause is named before any push or rerun.

## 6. Before you stop

Report what the PR cost: the number of pushes and CI runs (`gh run list --branch <branch>`) and the minutes per job of the last run (section 1 command).

When the change edits workflow files themselves (runners, triggers, path filters, concurrency, drafts, timeouts), read [`references/workflow-patterns.md`](references/workflow-patterns.md) first.

## 7. Clean up once it merges

As soon as the PR has merged (or closed for good), remove everything the work created. Leftovers pile up across sessions, fill disks and confuse the next agent.

1. **Confirm first.** For each item, check:
   - the PR is `MERGED` or `CLOSED` (`gh pr view <n> --json state`);
   - the item holds no uncommitted or unpushed work (`git -C <wt> status --porcelain`, `git log @{u}..` or `git log origin/main..HEAD` empty once the merge is on main);
   - no other open PR, stacked branch or running job uses it.
2. **Remove**, wherever the work ran (this machine, a server, a VM, a container host):
   - **Worktrees and branches:** `git worktree remove <wt>`, then `git worktree prune`. Delete the local branch, and the remote head branch if the repo doesn't auto-delete it (`gh api -X DELETE repos/<o>/<r>/git/refs/heads/<branch>`). Also delete helper refs such as `prove/*` or `cr/*` in bare or server repos.
   - **Server checkouts:** proof dirs, review dirs and clones made for this PR.
   - **Data:** test databases, schemas and users created for the PR; scratch volumes, buckets, Group Folders and tmp dirs; leftover containers and images from its test runs (`docker ps -a`, `docker volume ls` filtered by the label or name the tests use).
   - **Background work:** watchers, monitors, background shells, `nohup`/`systemd-run` jobs, and PR watches.
3. **Never remove:** anything dirty or unpushed (report it instead); shared caches, base images or the main checkout; anything a running job or another open PR uses; production data.
4. **Report** counts only: worktrees, branches, refs, server dirs, containers and volumes removed, plus anything kept and why.
