<!-- BEGIN agent-standard v1 (managed by the repo-defaults skill; change the skill, not this block) -->
## Agent standard (v1)

The global agent rules win over anything else in this repo: `t3-first`, `subagent-routing`, `pr-standards` with the `pr-workflow` skill, `credentials` and `repo-defaults` (`~/.agents/docs/agents/`). This repo's files supply facts and may add stricter checks; they never change that process.

- Repo facts: `docs/agents/repo.md`. Machine-readable settings (base, gate, setup, ports, env template, merge method): `.agents/repo.json`.
- Work in a T3 worktree, one branch per ticket. `agent-worktree` (`node "$HOME/.agents/bin/agent-worktree.mjs"`) sets the worktree up when it is created and tears it down when it settles. Do not set up or remove its resources by hand.
- Before a PR opens, run the `gate` from `.agents/repo.json` on the committed head. Then land it with `node "$HOME/.agents/bin/land-pr.mjs" <pr> --sha <gated sha>` and report the `land-pr` outcome (`MERGED`, `QUEUED`, `QUEUE-FULL` or `REFUSED`); on `QUEUED` or `QUEUE-FULL`, kick the repo's lander. Never merge another way.
- Credentials come from the 1Password vault `agent-repos` through `.env.op` (references only), injected into the gitignored `.env.local`. Store a new credential at once: value on stdin to `node "$HOME/.agents/bin/agent-secret.mjs" put <item> <ENV_NAME> --repo <repo>`. Never commit, print or pass a secret on argv.
- After the merge, clean up everything the work created. Teardown removes what it tracked; remove anything else yourself.
<!-- END agent-standard -->
