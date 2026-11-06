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
| `repo` | origin URL name | Lower-case name; prefixes ids and Docker labels |
| `itemPrefix` | `repo` | Required prefix of 1Password item names (`op://agent-repos/<itemPrefix>-...`) |
| `base` | `origin/HEAD`, else `main` | Base branch |
| `env.template`, `env.output` | `.env.op`, `.env.local` | 1Password references in, injected file out (must be git-ignored and untracked) |
| `ports` | `{}` | `{"PORT": 3000}`: each name gets `base + hash % 900`, probed free, stable per worktree |
| `setup`, `gate`, `affectedGate` | `[]` | Commands, split into argv without a shell. Use a script for pipes or `&&` |
| `ghWrapper` | none | Command that replaces `gh` (for example an identity wrapper), split like `setup` |
| `branchPattern` | `^agent/([A-Z]+-\d+)` | Group 1 is the ticket id |
| `remoteBranchDelete` | `^(agent\|revert)/` | Merged branches matching this lose their remote head at teardown |

Other keys (`vault`, `mergeMethod`, `mergeCmd`, `sweepEveryMerges`, `wideSweep`, `lockTtlMin`, `commandTimeoutMin`) belong to the landing tools.

## Hooks

An optional `.agents/hooks.mjs` exports `setup(ctx)`, `teardown(ctx)` and `sweep(ctx)`. Each must be idempotent. Hooks create and remove what the engine cannot see, such as preview databases or remote checkouts. Record each resource with `track` before you create it.

`ctx` holds `repo, repoRoot, worktreePath, wtId, branch, ticket, ports, dryRun, worktreeGone` and the functions `track(kind, id, where)`, `untrack(kind, id)`, `log(msg)` and `run(argv, opts)`. In `sweep`, `ctx.ledgers` lists the repo's ledgers, and `track` and `untrack` are not available.

A hook succeeds only when its function returns; one that throws or calls `process.exit` first counts as failed. Each hook runs in its own `node` process, in the worktree (or the main checkout once the worktree is gone), without `OP_SERVICE_ACCOUNT_TOKEN` in its environment. The engine never hands the token to a hook, a setup step or a gate. A hook still runs as the same user, so it could read a persisted token itself; only trusted repo code belongs in `hooks.mjs`.

## The ledger

Each worktree has a ledger at `<git-common-dir>/agent-resources/<wtId>.json`. It lives outside the worktree, so it survives the worktree's removal. `wtId` is `<repo>-<worktree folder>-<6 hex of the canonical worktree path>`, reduced to `[a-z0-9-]` and at most 40 characters, so two worktrees with the same folder name never share a ledger, ports or Docker label. Every command refuses to change a ledger that records another worktree that still exists.

Scripts that create resources mid-task record them:

```sh
node ~/.agents/bin/agent-worktree.mjs track docker-container <id>
node ~/.agents/bin/agent-worktree.mjs track dir .cache/build          # relative: resolved against the worktree
node ~/.agents/bin/agent-worktree.mjs track neon-branch <id> --where neon   # left to hooks.teardown
```

The engine removes `docker-container`, `docker-volume` and `docker-network` ids, every Docker object labelled `agent.wt=<wtId>` (so label containers you start), and local `file`, `dir`, `cache` and `path` entries. A tracked path is deleted only when, after resolving links and junctions, it lies inside this worktree, the temp folder or `~/.cache`. It is never the worktree itself, never inside the main checkout, the git dir or another worktree (including one nested inside this worktree), and never contains any of those or the home folder. A refused path keeps the worktree (exit 1). Hooks remove any other kind.

Locks: one lock per ledger, one repo-wide lock around port allocation, one per worktree around teardown (a second teardown exits 1), and one per repo around sweep (a second sweep skips the repo). Each lock file holds an owner token. A lock is stale when its holder's pid is dead or the lock is over two hours old; a stale lock is broken only under a separate `<lock>.recover` lock, so two processes never both break it. That recovery file is never reclaimed automatically; if a crash ever leaves one behind, the lock stays busy until you delete it.

## Setup

1. Records the worktree in its ledger (reactivating a torn-down one) and in `~/.agents/state/repos.json`.
2. Allocates the ports.
3. Runs `op inject` from the template into the output file (mode 0600). Every reference must be `op://agent-repos/<itemPrefix>-<item>/<field>`. The output must be untracked, git-ignored, not a link, and not under a linked folder. When any of that fails, or `op` or the service token is missing, setup warns loudly, injects no secrets (a usable output gets only the managed footer) and removes a stale untracked output, so a stale secret is never left behind. An output that is not git-ignored is removed only when setup wrote it earlier (its managed block, or the ledger records it), never a file you created.
4. Writes a managed footer (`AGENT_WT_ID` and the ports) into the output file.
5. Runs the `setup` commands. A rejected or failing command makes setup exit 1; a missing secret only warns. A broken config (for example an `env.output` outside the worktree) exits 2.
6. Runs `hooks.setup` and the `repo-defaults` drift check (warnings only), then starts `sweep --quick` in the background.

## Teardown

Teardown is idempotent. Exit 0 means T3 may remove the worktree; exit 1 means keep it, with the reason printed. It never deletes the worktree folder itself.

| State | Result |
|---|---|
| An open PR of the branch labelled `queued`, `landing`, `queue-blocked`, `queue-waiting` or `queue-hold` (a label left on a merged or closed PR is stale and ignored) | Keep, exit 1 |
| Uncommitted or untracked files (ignored files and an untracked env output are fine), whatever the PR state | Keep, exit 1 |
| No PR, or an open PR | Nothing removed, exit 0 |
| An open PR uses this branch as its base | Keep, exit 1 |
| Unpushed work | Keep, exit 1 |
| Detached HEAD with commits on no branch, remote or tag, or with uncommitted files | Keep, exit 1 |
| Merged or closed, clean, pushed | Clean up, exit 0 |

HEAD counts as pushed when any of these is true: it equals the PR head; a `Gate: pass @ <sha>` line in the PR body names it; no commit on it is outside the remotes; or `git range-diff` pairs every commit with the PR head's as identical. A squash merge therefore never looks unpushed.

Clean-up first lists processes. If the listing fails (including a missing `lsof` on macOS), nothing is removed and the worktree is kept. Otherwise it stops processes whose working directory, executable or a complete path argument is inside the worktree, and their descendants (a process that started before its recorded parent is not one). It never stops this process, its parents, the lifecycle tools, JetBrains IDEs or T3, and re-checks each pid's start time and command line before each signal. Windows does not expose a process's working directory, so a process started inside the worktree by an unrelated parent, with no path argument into it, is not matched there; the worktree's allocated ports catch the usual case, a dev server: if any of them is still in use (IPv4 or IPv6) once the hook and Docker clean-up have run, the worktree is kept before any file is deleted. It then runs `hooks.teardown` and `cr-review --cleanup <ticket>` when present, removes Docker objects and tracked paths, and deletes the env output file. For a merged PR whose branch matches `remoteBranchDelete`, it deletes the remote branch only while it still points at the PR head (a branch already gone counts as deleted; any other delete failure keeps the worktree). Any failure (GitHub unreadable, Docker erroring, a hook or `cr-review` failing, a refused path) keeps the worktree and exits 1.

## Sweep

`sweep` runs from an OS scheduler (daily, `--all`) and in the background after each setup (`--quick`). It:

- prunes stale worktree entries, and stops if `git worktree list` fails;
- finishes ledgers whose worktree is gone: not listed by git and not on disk (compared after resolving links). The local branch must still exist and pass the same rules as teardown (eligible PR, nothing unpushed); otherwise the ledger and its resources stay. A failed clean-up marks the ledger kept, and the next sweep retries it. A torn-down ledger is forgotten once its labelled Docker objects are gone;
- removes hand-made worktrees outside `~/.t3/worktrees` (compared after resolving links) by the teardown rules, with `git worktree remove` and never `--force` (T3 removes its own worktrees; `--quick` skips this step);
- deletes local branches whose PR merged or closed and that have nothing unpushed, except a branch an unfinished ledger still needs;
- runs the repo's `hooks.sweep(ctx)` once.

It reads every PR in one `gh` call. When that list fills its limit (1000, or `AGENT_WORKTREE_PR_LIMIT`), each branch is re-queried on its own. Sweep never touches the lander checkout `<repoRoot>-lander`. `status [--all] [--json]` lists the ledgers and why each was kept. `gate [--affected]` runs the repo's gate commands.

## Credentials

Credentials live in the shared 1Password vault `agent-repos`. Items are named `<repo>-<service>-<env>` with `env` either `dev` or `test`. The field label is the env var name. Production values never go into this vault; they stay in the deploy platform.

```sh
printf %s "$VALUE" | node ~/.agents/bin/agent-secret.mjs put demo-api-dev API_KEY --repo demo
node ~/.agents/bin/agent-secret.mjs import --env .env.local --map map.json --dry-run
node ~/.agents/bin/agent-secret.mjs ref demo-api-dev API_KEY
node ~/.agents/bin/agent-secret.mjs check
```

- `put` reads the value from stdin, never from arguments. It creates or edits the item through a JSON template on stdin, reads the value back and compares hashes, and prints the reference. Item names must end in `-dev` or `-test`. With `--repo`, the item name must start with `<itemPrefix>-`, and the reference is added to that repo's `.env.op` when you run it inside the repo (the template must be a file inside the checkout, not a link). It refuses `--env prod` and any `-prod` item, whatever `--env` says. It refuses to overwrite a field it did not create (fields it creates sit in the item's `agent-secret` section) unless you pass `--replace`, and never edits an item that holds a passkey (a JSON-template edit would overwrite it). Items go to `agent-repos` unless you pass `--vault`; a reference into another vault is not added to `.env.op`, and setup would refuse it.
- `import` parses an env file as data and stores each mapped key. The map is `{"ENV_NAME": "<item>" | {"item": "...", "field": "..."} | "skip"}`, with the same prod and prefix rules. It prints `migrated N, skipped M, mismatches K`, and exits 1 on any mismatch or refused field. With `--retire-source` and no mismatches, it moves the source to `<file>.pre-op` (mode 0600). It refuses when that file already exists or would not be git-ignored.
- `check` prints the account type and whether the vault is visible.

`op` is found on PATH, then (on Windows) in the WinGet package and links folders. The token comes from the process environment, then the Windows user environment or the mode-0600 `~/.config/op/agent-env-token` file. It is read once per process and given only to `op`.

## Tests

```sh
node --test "tests/lifecycle/*.test.mjs"
```

The tests use a real git with a local bare remote, and fake `gh`, `docker` and `op` (and a forwarding `git` for one failure case) on PATH. They need no network or credentials, and never touch the real home. In test mode (`AGENT_ENV_NO_SECRETS=1`), `AGENT_WORKTREE_TEST_PROCLIST_FAIL=1` simulates a failed process listing. `scripts/check.sh` belongs to the foundation area, so a follow-up PR wires `node --test` into it; until then run the command above before every commit that touches `home/dot_agents/bin/`.
