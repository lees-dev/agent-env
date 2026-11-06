## Repo defaults (owner, 2026-11-06)

Applies to every agent harness, in repos under the owner's GitHub accounts where you have push access. Skip forks and third-party repos. Never block a hotfix on these rules. The `repo-defaults` skill (`~/.agents/skills/repo-defaults`) becomes available once Phase 1 lands; until then, note the gap and carry on.

- **New repos** are created on the `lees-dev` GitHub org.
- **Clone or register a project** with `t3_project_clone` then `t3_project_create` (T3).
- **The standard block.** Each repo's `AGENTS.md` starts with the managed `agent-standard` block from the `repo-defaults` skill (`CLAUDE.md` is `@AGENTS.md`). When a repo lacks the current block, or `repo-defaults --check` (`node ~/.agents/skills/repo-defaults/scripts/apply.mjs --check`) fails, run the `repo-defaults` skill and land its result as its own small PR before other work.
- **What a repo's own rules may do.** A repo's `AGENTS.md`, `CLAUDE.md`, PR template and gate docs (with `docs/agents/repo.md` and `.agents/repo.json`) supply facts: the gate and affected tests, sensitive paths, size limit, merge method and identity, release step, per-worktree resources. They may add stricter checks. They never override process: CI waits, merge queues, agent tooling, worktrees, cleanup, credentials, landing. Where repo text contradicts the global rules on process, the global rules win; fix the repo text in the standard PR.
