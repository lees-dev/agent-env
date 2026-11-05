# CI cost model and sources

Checked against GitHub's docs on 2026-11-04. Prices and plans change: re-read the linked pages before quoting a number to someone.

## What costs money

- **Self-hosted runners are free on GitHub.** You pay only for the machine. GitHub announced a $0.002/min "Actions cloud platform" charge for self-hosted runners in December 2025, then postponed it with no new date. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)
- **Standard GitHub-hosted runners are free on public repos.** On private repos each plan includes a dollar amount per month (Free $12, Pro $18, Team $18, Enterprise Cloud $300). Past it, usage is billed to the payment method on file, or blocked when there is none. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- **Larger runners are billed even on public repos** and need a payment method. Rates scale with cores. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- **Per-minute rates** (USD): Linux 2-core $0.006, Windows 2-core $0.010, macOS 3/4-core $0.062, Linux 4-core $0.012, 8-core $0.022, 16-core $0.042, 64-core $0.162, Linux 4-core GPU $0.052. [Runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- **Each job is rounded up to the next whole minute.** Ten 5-second jobs bill as ten minutes. [Runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- **Third-party runner vendors** (Blacksmith, Namespace, BuildJet, Depot, WarpBuild, RunsOn and others) bill you themselves (or through your own cloud account), on their own terms: per minute, per second or per instance. Read the vendor's pricing page before estimating.
- **Time is time.** A job that sleeps, polls or waits on another system is billed (or holds the runner) for every minute it runs, up to `timeout-minutes` (default 360). [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

## What triggers a run

- `pull_request` runs on `opened`, `synchronize` and `reopened` when a workflow lists no `types`, so every push to the PR head (`synchronize`) re-runs CI, draft or not, unless the workflow filters drafts itself. `ready_for_review` and `converted_to_draft` are separate activity types. [Events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- `pull_request` workflows do not run while the PR has a merge conflict. [Events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- A merge queue runs `merge_group` workflows on top of the PR runs. [Events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- With `concurrency` and `cancel-in-progress: true`, a new run in the same group cancels the running one; [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency). The minutes a cancelled job already ran still count: billing is per job run time, rounded up per job ([Runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)); [UNVERIFIED] GitHub's docs do not say so for cancelled jobs in as many words.

## Re-runs

- `gh run rerun <run-id>` reruns every job; `--failed` reruns only failed jobs and their dependants; `--job <job-id>` reruns one job. Re-runs reuse the original commit, ref and actor's permissions, are allowed up to 30 days after the run, and at most 50 times per run. [Re-run](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

## Skipping

- `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]` in the commit message skips `push` and `pull_request` workflows (not `pull_request_target`). Skipped required checks stay "Pending" and block the merge until a later commit without the keyword. [Skip runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)

## Measuring

- Run and job timing: `gh run list --json …` and `gh run view <id> --json jobs` (fields `startedAt`, `completedAt`), from `gh` 2.102.0 help.
- Account billing (enhanced billing platform): `gh api /users/<user>/settings/billing/usage` or `gh api /organizations/<org>/settings/billing/usage`, with optional `year`, `month`, `day`. [Billing usage API](https://docs.github.com/en/rest/billing/usage)
- `gh` polls the REST API: `gh pr checks --watch` defaults to every 10 s and `gh run watch` to every 3 s. The REST quota is per account, shared by every agent using it. Check `gh api rate_limit` before REST-heavy work.
