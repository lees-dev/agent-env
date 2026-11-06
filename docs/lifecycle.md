# Worktree lifecycle and credentials

Two Node scripts deploy to `~/.agents/bin/` (source: `home/dot_agents/bin/`). They need Node 22 or later and have no npm dependencies. They print counts, ids and references, never secret values.

- `agent-worktree.mjs` prepares each agent worktree and cleans it up after its PR merges or closes.
- `agent-secret.mjs` stores credentials in 1Password and writes the references a repo's `.env.op` needs.

T3 Code runs the engine through two project scripts (global `defaultProjectScripts`, or a repo's `t3.json`):

```sh
node "$HOME/.agents/bin/agent-worktree.mjs" setup      # runOnWorktreeCreate, async false
node "$HOME/.agents/bin/agent-worktree.mjs" teardown   # runOnSettle
```

On Windows, write the absolute path to the script instead of `$HOME`: T3 runs project scripts in pwsh, powershell or cmd.

## Repo config

A repo describes itself in `.agents/repo.json` (version 1). Every key is optional; a repo without the file gets the defaults, so the keep rules protect it even before it adopts the standard.

| Key | Default | Use |
|---|---|---|
| `repo` | origin URL name | Lower-case name; prefixes ids, items and Docker labels |
| `base` | `origin/HEAD`, else `main` | Base branch |
| `env.template`, `env.output` | `.env.op`, `.env.local` | 1Password references in, injected file out (gitignored) |
| `ports` | `{}` | `{"PORT": 3000}`: each name gets `base + hash % 900`, probed free, stable per worktree |
| `setup`, `gate`, `affectedGate` | `[]` | Commands, split into argv without a shell. Use a script for pipes or `&&` |
| `branchPattern` | `^agent/([A-Z]+-\d+)` | Group 1 is the ticket id |
| `remoteBranchDelete` | `^(agent\|revert)/` | Merged branches matching this lose their remote head at teardown |

Other keys (`vault`, `mergeMethod`, `mergeCmd`, `ghWrapper`, `sweepEveryMerges`, `wideSweep`, `lockTtlMin`) belong to the landing tools.

An optional `.agents/hooks.mjs` exports `setup(ctx)`, `teardown(ctx)` and `sweep(ctx)`. Each must be idempotent. `ctx` holds `repo, repoRoot, worktreePath, wtId, branch, ticket, ports, dryRun, worktreeGone` and the functions `track(kind, id, where)`, `untrack(kind, id)`, `log(msg)` and `run(argv, opts)`. Hooks create and remove what the engine cannot see, such as preview databases or remote checkouts. Record each resource with `track` before you create it.

## The ledger

Each worktree has a ledger at `<git-common-dir>/agent-resources/<wtId>.json`. It lives outside the worktree, so it survives the worktree's removal. `wtId` is `<repo>-<worktree folder>`, reduced to `[a-z0-9-]` and at most 40 characters. Scripts that create resources mid-task record them:

```sh
node ~/.agents/bin/agent-worktree.mjs track docker-container <id>
node ~/.agents/bin/agent-worktree.mjs track dir /abs/path/to/cache
node ~/.agents/bin/agent-worktree.mjs track neon-branch <id> --where neon   # left to hooks.teardown
```

The engine removes `docker-container`, `docker-volume`, `docker-network`, and local `file`, `dir`, `cache` and `path` entries itself. It also removes every Docker object labelled `agent.wt=<wtId>`, so label containers you start. Hooks remove any other kind.

## Setup

1. Records the worktree in its ledger and in `~/.agents/state/repos.json`.
2. Allocates the ports.
3. Runs `op inject` from the template into the output file (mode 0600). Every reference must be `op://agent-repos/<repo>-<item>/<field>`; any other reference stops the injection. When `op` or the service token is missing, or a reference is refused, setup warns loudly and deletes the output file, so a stale secret is never left behind.
4. Writes a managed footer (`AGENT_WT_ID` and the ports) into the output file.
5. Runs the `setup` commands. A failing command is the only failure that makes setup exit non-zero.
6. Runs `hooks.setup` and the `repo-defaults` drift check (warnings only), then starts `sweep --quick` in the background.

The service-account token reaches only the `op` process. Setup commands, hooks and gates run without it.

## Teardown

Teardown is idempotent. Exit 0 means T3 may remove the worktree; exit 1 means keep it, with the reason printed. It never deletes the worktree folder itself.

| State of the branch's newest PR | Result |
|---|---|
| No PR, or open | Nothing removed, exit 0 |
| Labelled `queued`, `landing`, `queue-blocked` or `queue-waiting` | Keep, exit 1 |
| An open PR uses this branch as its base | Keep, exit 1 |
| Uncommitted or untracked files (ignored files are fine) | Keep, exit 1 |
| Unpushed work | Keep, exit 1 |
| Merged or closed, clean, pushed | Clean up, exit 0 |

HEAD counts as pushed when any of these is true: it equals the PR head; a `Gate: pass @ <sha>` line in the PR body names it; no commit on it is outside the remotes; or `git range-diff` pairs every commit with the PR head's as identical. A squash merge therefore never looks unpushed.

Clean-up stops processes running inside the worktree (never this process, its parents, JetBrains IDEs or T3), runs `hooks.teardown` and `cr-review --cleanup <ticket>` when present, removes labelled and tracked Docker objects and tracked paths, deletes the env output file, and deletes the remote branch of a merged PR that matches `remoteBranchDelete`. If GitHub cannot be read, teardown keeps everything and exits 1.

## Sweep

`sweep` runs from an OS scheduler (daily, `--all`) and in the background after each setup (`--quick`). It:

- prunes stale worktree entries;
- finishes the teardown of ledgers whose worktree is gone, then forgets them on the next run;
- removes hand-made worktrees outside `~/.t3/worktrees` by the teardown rules, with `git worktree remove` and never `--force` (T3 removes its own worktrees; `--quick` skips this step);
- deletes local branches whose PR merged or closed and that have nothing unpushed;
- removes labelled Docker leftovers of torn-down ledgers;
- runs the repo's `hooks.sweep(ctx)` once, with `ctx.ledgers` listing the ledgers (`track` and `untrack` are not available there).

It never touches the lander checkout `<repoRoot>-lander`. `status [--all] [--json]` lists the ledgers and why each was kept. `gate [--affected]` runs the repo's gate commands.

## Credentials

Credentials live in the shared 1Password vault `agent-repos`. Items are named `<repo>-<service>-<env>` with `env` either `dev` or `test`. The field label is the env var name. Production values never go into this vault; they stay in the deploy platform.

```sh
printf %s "$VALUE" | node ~/.agents/bin/agent-secret.mjs put demo-api-dev API_KEY --repo demo
node ~/.agents/bin/agent-secret.mjs import --env .env.local --map map.json --dry-run
node ~/.agents/bin/agent-secret.mjs ref demo-api-dev API_KEY
node ~/.agents/bin/agent-secret.mjs check
```

- `put` reads the value from stdin, never from arguments. It creates or edits the item through a JSON template on stdin, reads the value back and compares hashes, and prints the reference. With `--repo`, the item name must start with `<repo>-`, and the reference is added to that repo's `.env.op` when you run it inside the repo. It refuses `--env prod` and `-prod` items. It refuses to overwrite a field it did not create (fields it creates sit in the item's `agent-secret` section) unless you pass `--replace`.
- `import` parses an env file as data and stores each mapped key. The map is `{"ENV_NAME": "<item>" | {"item": "...", "field": "..."} | "skip"}`. It prints `migrated N, skipped M, mismatches K` and renames the source to `<file>.pre-op` only with `--retire-source` and no mismatches.
- `check` prints the account type and whether the vault is visible.

`op` is found on PATH, then (on Windows) in the WinGet package and links folders. The token comes from the process environment, then the Windows user environment or the mode-0600 `~/.config/op/agent-env-token` file.

## Tests

```sh
node --test "tests/lifecycle/*.test.mjs"
```

The tests use a real git with a local bare remote, and fake `gh`, `docker` and `op` on PATH. They need no network or credentials, and never touch the real home.
