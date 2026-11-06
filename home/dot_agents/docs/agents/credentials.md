## Credentials (owner, 2026-11-06)

Applies to every agent harness and every repo.

- **Every non-production credential lives in the 1Password vault `agent-repos`**, read through this machine's service account (`OP_SERVICE_ACCOUNT_TOKEN`). Items are named `<repo>-<service>-<env>` (for example `<repo>-neon-dev`), the field label is the env var name, and each item is tagged `repo:<name>`.
- **Repos commit `.env.op`**: references such as `op://agent-repos/<repo>-<service>-<env>/<ENV_NAME>` plus non-secret literals. It may reference only `op://agent-repos/<this repo>-…` items; the tools refuse others. Worktree setup (`agent-worktree setup`) injects a gitignored `.env.local` (mode 0600) from it; teardown deletes it. Never commit `.env.local` or work from a stale one.
- **One-off commands** that need a secret: `op run --env-file .env.op -- <command>`. Run gates and any untrusted or PR code through `agent-worktree gate` (it strips the token). `op run` passes your whole environment, including `OP_SERVICE_ACCOUNT_TOKEN`, to the command: use it only for trusted commands.
- **A credential you create** (API key, database password, token) is stored the same turn: pipe the value on stdin to `agent-secret put <item> <ENV_NAME> --repo <repo> --env <env>` (`node ~/.agents/bin/agent-secret.mjs`). It verifies the stored value and adds the reference to `.env.op`; commit that line.
- **Production values** stay in Vercel or the repo's release system. They never enter `agent-repos`, `.env.op` or any local file unless the owner says so; `agent-secret` refuses `--env prod`.
- **Never put a value in a command, argument, heredoc or `echo`.** Pipe it from the command that produces it, or redirect it from the file `request_secret` delivers (`delivery: "file"`) and delete that file right after storing. JSON templates go on stdin only (`op item create -`, `op item edit`). Never `cat` or print `.env.local` or `op read` output. Never write values into logs, PR bodies, Linear, comments or chat. Report counts and `op://` references, never values.
- **Do not pass `OP_SERVICE_ACCOUNT_TOKEN`** to repo setup commands, hooks, gates or untrusted PR code (the `agent-worktree` engine strips it from them).
- **If `op` or the service-account token is missing**, say so and stop the step that needs it. Do not copy values from other files or ask for them in chat.
- **A secret only a human has**: in T3, `request_secret` is the intake; then store it with `agent-secret put` so the next agent reads it from 1Password.
