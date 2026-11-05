# Packages: what installs each tool, per OS

The packages area installs the binaries. The harness area configures them. Every install is user-level unless the owner opts in for one apply, and every step is safe to rerun.

## Who installs what

| Tool | Windows (Beast) | WSL Ubuntu, Linux, macOS |
|---|---|---|
| Claude Code | `https://claude.ai/install.ps1 <pin>` → `~\.local\bin\claude.exe` | `https://claude.ai/install.sh <pin>` → `~/.local/bin/claude` |
| Codex | `npm install -g @openai/codex@<pin>` → `%APPDATA%\npm` | mise `codex` (the GitHub release binary, `aqua:openai/codex`) |
| Grok | `https://x.ai/cli/install.ps1 -Version <pin>` → `~\.grok\bin` | `https://x.ai/cli/install.sh <pin>` → `~/.grok/bin` |
| Muse Code | `https://dev.meta.ai/install.ps1` → `%LOCALAPPDATA%\Programs\muse` | `https://dev.meta.ai/install.sh` → `~/.local/bin/muse` |
| node, uv, gh, oh-my-posh | winget | mise, at `~/.local/share/mise` |
| Python 3.13 | winget `Python.Python.3.13` (`py`, `python`) | `uv python install 3.13` → `~/.local/bin/python3.13` |
| Python 3.12 | `uv python install 3.12` | `uv python install 3.12` |
| git | winget `Git.Git` (per-machine) | apt / dnf / brew (opt-in); the server role keeps the OS copy |
| Tailscale | winget (per-machine) | Linux client: `tailscale.com/install.sh` (opt-in); macOS: cask `tailscale-app` (opt-in); WSL: the Windows host's; server: the OS copy |
| chezmoi, 1Password CLI | winget (the runbook installs them first) | the runbook installs them; verify warns on drift |
| CodeRabbit CLI | none (no Windows build) | `https://cli.coderabbit.ai/install.sh` with `CODERABBIT_VERSION=<pin>` → `~/.local/bin` |
| mise | not used | `https://mise.run` with `MISE_VERSION=v<pin>` → `~/.local/bin/mise` |

Muse is the exception to pinning. Its installer sets up a launcher that follows the `muse-stable` channel and updates itself, so it is installed when missing and verify only warns when its version differs from `versions.toml`.

Claude Code's native build also updates itself. The install script puts it back on the pin when it drifts, so agent-env sets `env.DISABLE_AUTOUPDATER = "1"` in Claude's settings (`harness/config.toml` `disable_autoupdater`); without it verify would fail after each auto-update.

## Run scripts

All of these are `run_onchange_before_`, so the binaries exist before any config is written and before the harness area's `run_after_3N` scripts call `claude mcp add` and the like. Each one embeds the pins it uses, so editing `versions.toml` or a list in `packages/` re-runs it.

| Script | Windows (`.ps1`) | WSL, Linux, macOS (`.sh`) |
|---|---|---|
| `10-packages-path` | adds missing user PATH entries (registry, `%VAR%` form kept, old value saved in the latest `~/.agent-env-backups/<ts>/`); hooks `env.sh` into Git Bash `~/.bashrc` | hooks `env.sh` into `~/.bashrc`, `~/.zshrc` and the login file |
| `11-packages-…` | `winget`: `packages/winget.txt`, then Python 3.12 via uv | `system`: `packages/apt.txt`, `dnf.txt` or `Brewfile`, and Tailscale (opt-in only) |
| `12-packages-mise` | (none) | mise, then `packages/mise-tools.toml`, Python via uv, CodeRabbit |
| `13-packages-harnesses` | Claude, Grok, Muse installers; `packages/npm-global.txt` | Claude, Grok, Muse installers |

`AGENT_ENV_DRY_RUN=1` makes every one of them print what it would do and change nothing. The flag is rendered into each script (`# dry-run=1`), because chezmoi records every `run_onchange_` script it runs by the hash of its contents. So a dry run never stands in for the real run: the next apply without the flag has different contents and runs each script for real. Only these four scripts honour the flag: the same apply still writes the files and runs scripts `20`-`40` for real.

## mise pins

On WSL, Linux and macOS the pins for mise's tools go in `~/.config/mise/conf.d/agent-env.toml`. mise loads `conf.d` fragments before `~/.config/mise/config.toml`, so the owner's own `config.toml` (and `config.local.toml`) win over them (https://mise.jdx.dev/configuration.html#conf-d). agent-env never edits those files. If one pins a tool that agent-env also pins, verify names the tool in a WARN, and its version check FAILs until the owner removes that line.

## PATH

`~/.config/agent-env/env.sh` sources `~/.config/agent-env/env.d/*.sh`. `env.d/10-packages.sh` moves these to the front of PATH, in this order:

- WSL, Linux, macOS: mise shims, `~/.local/bin`, `~/.grok/bin`. The shims come first so the pinned node, uv, gh and codex win over older copies, such as WSL's `~/.local/bin/uv` or `/usr/local/bin/codex`.
- Git Bash: `~/.local/bin`, `~/.grok/bin`, `~/.config/agent-env/gitbash-bin`, `%APPDATA%/npm`. Bash cannot run `muse.cmd` by its bare name, so `gitbash-bin/muse` forwards to it. It is not in `~/.local/bin`, because PowerShell would try to open an extensionless file there as a document.

The block that sources `env.sh` is marked `# >>> agent-env >>>` / `# <<< agent-env <<<` and added once. Another area that needs shell setup adds its own `env.d/<NN>-<area>.sh` instead of a second block.

## The owner's opt-in for system packages

On Unix, the owner runs this in their own terminal because sudo needs a TTY, or installs the listed packages first. Use the token-loader and PATH steps from AGENTS.md step 5.

Per-machine winget installers (Git, GitHub CLI, Node, Tailscale) raise UAC prompts. apt, dnf and brew change the system. They run only when the owner says yes in step 0 of the runbook, for that one apply:

Use AGENTS.md step 5 for the apply command, including its PATH refresh and persisted-token loader. Choose the opt-in alternative there only after the owner's yes.

The opt-in is rendered into the scripts, so turning it on later re-runs them. Without it, they list what is missing and carry on. A tool that needs a missing system package is skipped, not failed, so the rest of the apply still lands: on Windows, `13-packages-harnesses` skips codex when Node (per-machine) is missing, and `scripts/verify` FAILs codex until an apply with the opt-in. `13` renders the opt-in too, so that apply re-runs it. The `server` role never uses sudo, whatever the variable says. Those scripts only install missing packages. They never upgrade or remove a system package, and winget never downgrades a tool that is newer than its pin.

## Windows: never from inside the Claude desktop app

The Claude desktop app is an MSIX package. Windows silently redirects its child processes' writes under `%APPDATA%` and `%LOCALAPPDATA%` into the package. An install run from there lands where no normal shell can see it. Every packages `.ps1` checks its parent processes and stops if it finds the package. Run `chezmoi apply` from Windows Terminal, PowerShell or Git Bash.

## WSL and the Windows boundary

WSL puts Windows directories (`/mnt/c/...`) on PATH. The `.sh` scripts drop them from their own PATH before they install anything, so `npm`, `node` or `codex` can never resolve to the Windows copy. Verify fails if a tool resolves under `/mnt`. Nothing here installs into the other OS: Windows and WSL each run their own apply.

## Per-machine versions

- `versions.toml` `[overrides.<machine>]`: committed, keyed by machine remark. None are committed today; prefer the local file below for one machine's intentional pins, such as a server's `uv = "0.12.3"`.
- `~/.config/agent-env/versions.local.toml`: machine-local, never in git, and it wins over both:
  ```toml
  [overrides]
  gh = "2.100.0"
  oh-my-posh = "skip"   # do not install or upgrade it on this machine
  ```
  Run `chezmoi apply` after editing it. The templates read it through `home/.chezmoitemplates/packages/pins.json`.
