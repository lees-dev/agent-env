# Repo facts for agents

Facts only. Process (worktrees, landing, cleanup, credentials) comes from the global rules and the
managed block at the top of `AGENTS.md`; a line here may add a stricter check, never a different
process. Machine-readable settings live in `.agents/repo.json`. Replace every placeholder below.

## Gate

- Command (runs on the committed head before a PR opens): TODO(repo-defaults)
- Affected tests only (what the lander reruns after a rebase): TODO(repo-defaults)
- Browser / E2E specs: only those the change adds or edits run before the PR; the wide sweep runs on the base every few merges. TODO(repo-defaults)

## Merging and release

- Merge method and identity: TODO(repo-defaults)
- Release and production approval: production stays behind the release step; never promote without the owner's approval. TODO(repo-defaults)

## Sensitive paths and size

- Sensitive paths (security, auth, data, migrations, concurrency, CI): TODO(repo-defaults)
- Size limit per PR: TODO(repo-defaults)

## Per-worktree resources

- Ports, databases, containers, caches, previews each worktree creates, and the hook that removes them (`.agents/hooks.mjs`): TODO(repo-defaults)

## Secrets

- Vault `agent-repos`, items `<repo>-<service>-<env>`, references in `.env.op`. Local-only services (for example an in-process database) instead of shared ones: TODO(repo-defaults)

## Platform notes

- Windows / WSL / Linux differences, required tools and versions: TODO(repo-defaults)
