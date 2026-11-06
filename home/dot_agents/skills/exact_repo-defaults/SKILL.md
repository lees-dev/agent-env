---
name: repo-defaults
description: Bring a repo to the agent standard (managed AGENTS.md block, CLAUDE.md import, t3.json, .agents/repo.json, docs/agents/repo.md, gitignore lines) and list the CI and secrets work left for separate PRs. Use after t3_project_clone or t3_project_create, when a repo lacks the current agent-standard block, or when `apply.mjs --check` fails.
---

# Repo defaults

The global rule `repo-defaults` (`~/.agents/docs/agents/repo-defaults.md`) says when to run this: after cloning or registering a project, or when a repo lacks the current block, before other work. Land the result as its own small PR.

## Steps

1. Work in a T3 worktree on a branch such as `agent/<TICKET>-repo-defaults`.
2. Look first; this writes nothing:
   ```sh
   node "$HOME/.agents/skills/repo-defaults/scripts/apply.mjs" --inspect
   ```
3. Apply:
   ```sh
   node "$HOME/.agents/skills/repo-defaults/scripts/apply.mjs" --apply
   ```
   It never rewrites repo-owned text. It:
   - inserts the managed block (`assets/agents-block.md`, `agent-standard v1`) at the top of `AGENTS.md`, or replaces exactly an older block's text in place (two blocks are reported for you to fix by hand);
   - creates `CLAUDE.md` as `@AGENTS.md`, or prepends that import to an existing one (a `CLAUDE.md` that is the same file as `AGENTS.md` is left alone);
   - creates `t3.json` (`assets/t3.json`: worktree mode, the `agent-worktree` setup and teardown scripts), or puts those two scripts first and turns other automatic scripts into manual ones, because T3 runs only the first setup and the first settle script. Only exact copies of the two are dropped; a custom script that calls `agent-worktree` and does more is kept as a manual script and reported: move its extra work into `.agents/repo.json` `setup` or `.agents/hooks.mjs`; T3 runs these from `t3.json`, or from the global `defaultProjectScripts` that machine setup configures (agent-env `docs/lifecycle.md`); a T3 project with its own saved scripts uses those instead, so check in its settings that setup and teardown match `assets/t3.json`;
   - creates `.agents/repo.json` from detection (package manager from the lockfile, base from `origin/HEAD`, gate from a `gate` script), or adds missing keys to an existing one;
   - makes `.env.local` and `.env.local.pre-op` ignored by the repo's own `.gitignore` (a global excludes file does not count: the next clone lacks it);
   - creates `docs/agents/repo.md` from `assets/repo.md`.
4. Fill in every `TODO(repo-defaults)` in `.agents/repo.json` and `docs/agents/repo.md` from the repo itself: the gate and affected-tests commands, sensitive paths, size limit, merge method and identity (`mergeCmd` / `ghWrapper`), release step, per-worktree resources, wide sweep. A repo without a single gate command gets one (for example a `gate` script that runs lint, typecheck, build and the affected tests) in this PR. Commands are argv strings without shell features; point at a script when you need them.
5. Move repo text that contradicts the global rules on process (CI waits, merge queues, agent tooling, worktrees, cleanup, credentials, landing) out of `AGENTS.md`/`CLAUDE.md`, or reword it as a fact. Keep facts and stricter checks.
6. Verify: `node "$HOME/.agents/skills/repo-defaults/scripts/apply.mjs" --check` exits 0. Run the repo's gate, then open and land the PR per `pr-workflow`.

## Left for separate PRs (from `--inspect`)

- **PR-gating CI**: workflows triggered by `pull_request`, `pull_request_target` or `merge_group`, and rulesets with required checks or a merge queue. Remove them in their own PR (`pr-standards`); keep release and deploy workflows and non-gating backstops. Ruleset edits are the owner's.
- **Secrets**: env files with values (`.env`, `.env.production`, ...; not templates such as `.env.example`, and not `.env.local`, which worktree setup writes from `.env.op`). Move them into the 1Password vault `agent-repos` with `node "$HOME/.agents/bin/agent-secret.mjs" import` and commit `.env.op` (format: `assets/env.op.example`). A tracked env file holding values means a leaked secret: tell the owner and rotate it.

## Assets

| File | Becomes |
| --- | --- |
| `assets/agents-block.md` | The managed block at the top of `AGENTS.md`. Change the standard here, bump the version, then rerun `--apply` in each repo |
| `assets/t3.json` | `t3.json` |
| `assets/repo.json` | The shape of `.agents/repo.json` (detection fills it) |
| `assets/repo.md` | `docs/agents/repo.md` |
| `assets/env.op.example` | The `.env.op` format (not copied) |

`--check` exits 1 on drift and runs offline, so a repo can call it from its gate.
