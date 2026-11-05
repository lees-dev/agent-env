# agent-env

## Bootstrap

Open Claude Code or Codex and say:

> Run the setup.md prompt at https://github.com/lees-dev/agent-env/blob/main/setup.md

You can also hand the agent the [raw prompt](https://raw.githubusercontent.com/lees-dev/agent-env/main/setup.md) or open it in an existing checkout and say "run the setup.md prompt". [`setup.md`](setup.md) lists the owner prerequisites, clones the public repo when needed, and follows [`AGENTS.md`](AGENTS.md).

The secret-free tools stage runs immediately after cloning, before 1Password or the hub is ready. It installs Claude Code, Codex, Grok, Muse Code, and the development stack: Node 24 LTS, pnpm, Bun, Temurin Java 25, Maven 3.10, ripgrep, GitHub CLI, Git, uv, Python, Higgsfield CLI, and Vercel. Desktop roles also get T3 Code and, with system-package approval, JetBrains Toolbox and Docker Desktop on Windows/macOS. Unix gets CodeRabbit CLI.

Apply then adds shared skills, global rules, and CLIProxyAPI-over-Tailscale wiring on Windows native, WSL Ubuntu, Rocky/RHEL Linux, and macOS. Setup defaults to a client of BEAST. It installs the proxy only when the owner explicitly selects the hub role.

## Why

Before this repo, each machine was configured by hand. Versions drifted, skills existed in three different copies, rules were missing on some harnesses, and keys sat in plaintext backups. Now one source state renders per machine, and each machine fetches its secrets from 1Password at apply time. Harness-owned config files are merged, never overwritten.

## Map

| Path | What |
|---|---|
| `AGENTS.md` | The runbook for the installing agent, plus the rules for working in this repo |
| `home/` | chezmoi source state (`.chezmoiroot`); `home/.chezmoi.toml.tmpl` asks the questions |
| `versions.toml` | Pinned versions of every harness and tool, resolved from their registries |
| `scripts/` | `install-tools`, `preflight`, `backup`, `verify` (POSIX sh, plus a `.ps1` for each on Windows), `check.sh`, `secret-guard.sh`, `render-test.sh` |
| `packages/`, `tailscale/` | Package lists per manager; the tailnet policy snippet for the hub |
| `tests/render/` | The paths each test scenario must render (`docs/testing.md`) |
| `docs/layout.md` | Which directory each area owns; naming rules; template data keys |
| `docs/cpa.md`, `docs/packages.md`, `docs/skills.md` | The hub wiring and per-machine key procedures; installs per OS; where each skill came from |
| `docs/testing.md` | Rendering the whole tree into a throwaway home, without 1Password |
| `docs/research.md` | Versions, sources and primary docs for every tool used; what is `[UNVERIFIED]` |

No secret, key, token, OAuth file, account email, log or client data is ever committed here. CI scans every push.
