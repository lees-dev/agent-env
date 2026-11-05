# Workflow patterns that keep CI cheap

Read this when your change edits files under `.github/workflows/`. Workflow and CI-config changes are often code-owner or gated paths: check the repo's rules before editing them.

## Runners

Keep each job on the cheapest runner that does the work. A new `runs-on` label that is GitHub-hosted (private repo), larger or vendor-billed is a cost decision for the repo owner: propose it in the PR description and wait for a yes.

## Cancel superseded runs

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}
  cancel-in-progress: true
```

`github.head_ref` exists only on pull-request events, so other events fall back to a unique run id and are never cancelled. [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## Skip drafts

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  test:
    if: github.event.pull_request.draft == false
```

`ready_for_review` starts the run when the draft is marked ready. [Events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [`draft` field](https://docs.github.com/en/rest/pulls/pulls)

## Skip heavy jobs for docs-only changes

Workflow-level `paths` / `paths-ignore` stop the whole workflow, and a required check from a workflow that never runs stays "Pending" and blocks the merge. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

When the check is required, filter at job level instead: a cheap `changes` job computes what changed (`git diff --name-only` against the base), heavy jobs use `needs: changes` plus an `if:` on its outputs, and one always-run aggregator job (`if: always()`, `needs: [all jobs]`) is the required check and fails when any needed job failed. Skipped jobs count as passing for required checks; a workflow that never started does not. [Required checks](https://docs.github.com/en/github/administering-a-repository/troubleshooting-required-status-checks)

## Bound every job

Set `timeout-minutes` on each job; the default is 360. A hung job bills until the timeout. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

## Wait on events, not in jobs

A gate that needs another system's result (a review bot, an external check) runs on that system's event (`pull_request_review`, `check_run`, `workflow_run`, `status`) rather than sleeping inside a job. A job that polls bills for every minute it waits.
