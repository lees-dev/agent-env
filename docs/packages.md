# Packages: what installs each tool, per OS

The packages area installs the binaries. The harness area configures them. Setup defaults to the owner approving system packages. Every install is user-level unless the owner opts in for that stage or apply, and every step is safe to rerun.

## Who installs what

| Tool | Windows (Beast) | WSL Ubuntu, Linux, macOS |
|---|---|---|
| Claude Code | `https://claude.ai/install.ps1 <pin>` → `~\.local\bin\claude.exe` | `https://claude.ai/install.sh <pin>` → `~/.local/bin/claude` |
| Codex | `npm install -g @openai/codex@<pin>` → `%APPDATA%\npm` | mise `codex` (the GitHub release binary, `aqua:openai/codex`) |
| Grok | `https://x.ai/cli/install.ps1 -Version <pin>` → `~\.grok\bin` | `https://x.ai/cli/install.sh <pin>` → `~/.grok/bin` |
| Muse Code | `https://dev.meta.ai/install.ps1` → `%LOCALAPPDATA%\Programs\muse` | `https://dev.meta.ai/install.sh` → `~/.local/bin/muse` |
| Node 24 LTS, uv, gh, oh-my-posh | winget | mise, at `~/.local/share/mise` |
| Python 3.13 | winget `Python.Python.3.13` (`py`, `python`) | `uv python install 3.13` → `~/.local/bin/python3.13` |
| Python 3.12 | `uv python install 3.12` | `uv python install 3.12` |
| git | winget `Git.Git` (per-machine) | apt / dnf / brew (opt-in); the server role keeps the OS copy |
| Tailscale | winget (per-machine) | Linux client: `tailscale.com/install.sh` (opt-in); macOS: cask `tailscale-app` (opt-in); WSL: the Windows host's; server: the OS copy |
| chezmoi, 1Password CLI | winget (the runbook installs them first) | the runbook installs them; verify warns on drift |
| CodeRabbit CLI | none (no Windows build) | `https://cli.coderabbit.ai/install.sh` with `CODERABBIT_VERSION=<pin>` → `~/.local/bin` |
| pnpm, Bun, Higgsfield CLI, Vercel | `packages/npm-global.txt` via npm at `%APPDATA%/npm` | the same npm list, using pinned mise Node and prefix `~/.local` |
| Temurin Java 25 | winget `EclipseAdoptium.Temurin.25.JDK`; user `JAVA_HOME` | mise `java`, vendor-specific Temurin pin; shell hook exports `JAVA_HOME` |
| Maven 3.10 | SHA-512 verified Maven Central zip under `~/.local/share/maven` | mise `maven` |
| ripgrep | winget `BurntSushi.ripgrep.MSVC` | mise `ripgrep` (not the distro copy) |
| T3 Code | desktop roles: winget `T3Tools.T3Code`, per user; `t3code.cmd` on PATH | macOS: verified official DMG in `~/Applications`; apt desktop + opt-in: verified Debian package; other Linux desktops: verified AppImage and menu entry, `t3code` on PATH; WSL uses the Windows app; never server |
| JetBrains Toolbox | desktop + opt-in: winget `JetBrains.Toolbox` | desktop + opt-in: official pinned DMG or Linux tarball; user install and launcher |
| Docker Desktop | desktop + opt-in: winget `Docker.DockerDesktop` | macOS desktop + opt-in: official pinned DMG in `/Applications`; Linux: manual, see below; never WSL/server |
| mise | not used | `https://mise.run` with `MISE_VERSION=v<pin>` → `~/.local/bin/mise` |

Muse is the exception to pinning. Its installer sets up a launcher that follows the `muse-stable` channel and updates itself, so it is installed when missing and verify only warns when its version differs from `versions.toml`.

Claude Code's native build also updates itself. The install script puts it back on the pin when it drifts, so agent-env sets `env.DISABLE_AUTOUPDATER = "1"` in Claude's settings (`harness/config.toml` `disable_autoupdater`); without it verify would fail after each auto-update.

## Run scripts

All of these are `run_onchange_before_`, so the binaries exist before any config is written and before the harness area's `run_after_3N` scripts call `claude mcp add` and the like. Each one embeds the pins it uses, so editing `versions.toml` or a list in `packages/` re-runs it.

| Script | Windows (`.ps1`) | WSL, Linux, macOS (`.sh`) |
|---|---|---|
| `10-packages-path` | adds missing user PATH entries (registry, `%VAR%` form kept, old value saved in the latest `~/.agent-env-backups/<ts>/`); hooks `env.sh` into Git Bash `~/.bashrc` | hooks `env.sh` into `~/.bashrc`, `~/.zshrc` and the login file |
| `11-packages-…` | `winget`: non-desktop rows in `packages/winget.txt`, then Python 3.12 via uv | `system`: `packages/apt.txt`, `dnf.txt` or `Brewfile`, and Tailscale (opt-in only) |
| `12-packages-mise` / `12-packages-development` | verified Maven archive | mise, then `packages/mise-tools.toml`, Python via uv, CodeRabbit |
| `13-packages-harnesses` | Claude, Grok, Muse installers; `packages/npm-global.txt` | Claude, Grok, Muse installers and the shared npm globals |
| `14-packages-desktop` | desktop rows in `packages/winget.txt`, after all development tools and harnesses | official desktop assets from `packages/desktop.txt` |

`AGENT_ENV_DRY_RUN=1` makes every one of them print what it would do and change nothing. The flag is rendered into each script (`# dry-run=1`), because chezmoi records every `run_onchange_` script it runs by the hash of its contents. So a dry run never stands in for the real run: the next apply without the flag has different contents and runs each script for real. Only the package scripts honour the flag: the same apply still writes the files and runs scripts `20`-`40` for real.

## mise pins

On WSL, Linux and macOS the pins for mise's tools go in `~/.config/mise/conf.d/agent-env.toml`. mise loads `conf.d` fragments before `~/.config/mise/config.toml`, so the owner's own `config.toml` (and `config.local.toml`) win over them (https://mise.jdx.dev/configuration.html#conf-d). agent-env never edits those files. If one pins a tool that agent-env also pins, verify names the tool in a WARN, and its version check FAILs until the owner removes that line.

## PATH

`~/.config/agent-env/env.sh` sources `~/.config/agent-env/env.d/*.sh`. `env.d/10-packages.sh` moves these to the front of PATH, in this order:

- WSL, Linux, macOS: mise shims, `~/.local/bin`, `~/.grok/bin`. The shims come first so the pinned node, uv, gh and codex win over older copies, such as WSL's `~/.local/bin/uv` or `/usr/local/bin/codex`.
- Git Bash: `~/.local/bin`, `~/.grok/bin`, `~/.config/agent-env/gitbash-bin`, `%APPDATA%/npm`. Bash cannot run `muse.cmd` by its bare name, so `gitbash-bin/muse` forwards to it. It is not in `~/.local/bin`, because PowerShell would try to open an extensionless file there as a document.

The block that sources `env.sh` is marked `# >>> agent-env >>>` / `# <<< agent-env <<<` and added once. Another area that needs shell setup adds its own `env.d/<NN>-<area>.sh` instead of a second block.

## The owner's opt-in for system packages

On Unix, the owner runs the commands in "Run tools before credentials" in their own terminal because sudo needs a TTY. Alternatively, install the listed packages first. For a normal apply, use the token-loader and PATH steps from AGENTS.md step 5.

Per-machine winget installers (Git, GitHub CLI, Node, Tailscale, Temurin, Docker Desktop) raise UAC prompts. apt, dnf and brew change the system. They run only when the owner says yes in step 0 of the runbook, for that tools stage or apply.

Use AGENTS.md step 5 for the apply command, including its PATH refresh and persisted-token loader. Choose the opt-in alternative there only after the owner's yes.

The opt-in is rendered into the scripts, so turning it on later re-runs them. Without it, they list what is missing and carry on. A tool that needs a missing system package is skipped, not failed, so the rest of the apply still lands: on Windows, `13-packages-harnesses` skips codex when Node (per-machine) is missing, and `scripts/verify` FAILs codex until an apply with the opt-in. `13` renders the opt-in too, so that apply re-runs it. The `server` role never uses sudo, whatever the variable says. Those scripts only install missing packages. apt/dnf/brew never upgrade or remove a base package. Desktop installers and winget install missing or older tools and never downgrade newer versions. T3 Code, Toolbox, and Docker Desktop may update themselves: verify warns with `self-updated` for newer versions and fails for missing or older versions. macOS bundles are staged beside the destination and replaced, so files from an older bundle cannot survive the copy. Docker copies without sudo when `/Applications` is writable; otherwise it requires a current sudo ticket. The opted-in tools stage refreshes that ticket throughout the run and stops its keepalive on exit.

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
  Java uses separate runtime and installer IDs. Set the keys together when changing its version (these values describe the current pin):
  ```toml
  [overrides]
  java = "25.0.4.1"                    # java --version / JAVA_HOME release
  java_winget = "25.0.4.101"           # Windows manifest version
  java_mise = "temurin-25.0.4+101.0.LTS" # Unix metadata ID
  ```
  `java = "skip"` skips all three and preserves an inherited `JAVA_HOME`. Without a skip, a failed or empty `mise where` also preserves it. Java overrides do not derive installer IDs from the runtime string. Any tool takes `<name>_winget` and `<name>_mise` the same way; for example Toolbox's winget manifest adds a fourth segment, so `toolbox = "3.9.2"` needs `toolbox_winget = "3.9.2.0"` (check the real manifest version with `winget show --id JetBrains.Toolbox --versions`). The same keys work under `[overrides.<machine>]` in `versions.toml`.

  A different `t3code` version requires all six matching SHA-256 values in the same override block: `t3code_sha256_macos_arm64`, `t3code_sha256_macos_x64`, `t3code_sha256_linux_arm64`, `t3code_sha256_linux_x64`, `t3code_sha256_deb_arm64`, and `t3code_sha256_deb_x64`. Get the digests from that version's official release at https://api.github.com/repos/pingdotgg/t3code/releases/tags/v<VERSION>. Missing or malformed digests stop rendering; the installer never reuses the default version's checksums. A machine-local version and its checksums must be together even when committed overrides exist. `t3code = "skip"` requires no checksums.

  Run `chezmoi apply` after editing it. The templates read it through `home/.chezmoitemplates/packages/pins.json`.

## Run tools before credentials

Run after cloning, before 1Password provisioning or preflight. On Windows, first wait for the owner's Tailscale and 1Password CLI winget commands to finish; concurrent MSI installers can fail with error 1618:

```powershell
$env:AGENT_ENV_SYSTEM_PACKAGES = '1'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-tools.ps1 -Role client -Machine <remark>
```

On Linux, WSL, or macOS, the owner runs this in their terminal:

```sh
sudo -v
AGENT_ENV_SYSTEM_PACKAGES=1 sh scripts/install-tools --role client --machine <remark>
```

For a server, run `sh scripts/install-tools --role server --machine <remark>` with no sudo. On Windows, select `-Role server`. Both entry points force system packages off for that role. The main runbook still requires provisioning, preflight, init, backup, apply, and verify for configuration and secrets.

The stage bootstraps chezmoi at the pin in `versions.toml` if absent, then copies the exact files in `packages/tools-stage.txt` into a temporary `.tools/` source. It adds a dedicated tools config and ignore file, with separate state, cache, and config paths. Only package templates and scripts 10-14 are available; no secret partial, normal config, hub script, or token loader exists in that source. This is a production path and never uses `AGENT_ENV_NO_SECRETS`. It installs all four harnesses even if the existing normal config selects fewer.

Both stage and apply run the same scripts against the same `versions.toml`, package lists, and machine overrides. Scripts check installed pins, so apply can run them again without reinstalling matching tools. Muse remains a channel launcher. Version changes or a changed opt-in rerun the affected `run_onchange_` scripts. Deleting a binary does not change a script's rendered contents, so an unchanged normal apply does not repair it. Rerun the tools stage to restore a missing tool; its fresh state runs the package scripts again.

Unix prerequisites are curl or wget, CA certificates, tar, gzip, and a POSIX shell for chezmoi's bootstrap. The system stage supplies the remaining installer prerequisites. The owner supplies missing prerequisites in their TTY; server administrators supply them without agent sudo. macOS needs Command Line Tools for Git; Homebrew base packages require Homebrew from https://brew.sh, but pinned development tools and desktop downloads do not require brew. Linux desktop roles need their distro's normal graphical runtime libraries. A headless Linux device must select `server`.

To inspect the stage without installing anything, set `AGENT_ENV_DRY_RUN=1`. Supply an existing chezmoi binary through `AGENT_ENV_CHEZMOI` if it is not on PATH. Dry runs execute only dry package scripts, use a throwaway destination, and deploy no files. They also do not bootstrap chezmoi. `scripts/tools-test.py` checks dry runs, isolation, all-harness defaults, and desktop role filters.

The stage deploys the PATH hook, its package-only environment fragment, the Git Bash Muse forwarder, and Unix mise pins. Refresh Windows Machine + User PATH after it returns. On Unix, source `~/.config/agent-env/env.d/10-packages.sh` or start a new login shell. Do not source the full `env.sh` before provisioning: an existing CPA drop-in may load credentials. Windows Maven uses a stable `~/.local/bin/mvn.cmd` launcher pointing to the pinned archive, so a version bump cannot leave an old bin directory first on PATH. Temurin's JDK is exported through `JAVA_HOME`. On apt desktops with the system-package opt-in, Linux T3 uses the checksum-verified release `.deb` through `sudo apt-get install`, including its Electron sandbox setup and menu entry. Verify reads the installed Debian package version. Otherwise T3 uses AppImage extraction mode to avoid FUSE; verify reads its `X-AppImage-Version` desktop metadata without starting Electron. Ubuntu 24.04+ AppArmor restrictions can prevent the AppImage sandbox from starting. Prefer the opted-in apt install there; other restricted desktops need an administrator-approved AppArmor profile. Verify warns when that restriction is enabled. It never disables the sandbox or changes the sysctl. Toolbox verification reads `bin/build.txt`, including arm64 archive directories and its updater directory. No desktop GUI is launched during install or verify.

Linux Docker Desktop is not installed automatically. Follow https://docs.docker.com/desktop/setup/install/linux/ after checking the supported distribution and virtualization requirements. WSL uses the Windows Docker Desktop integration. Launch Docker Desktop yourself on Windows/macOS, then approve its integration and start its engine. T3 Code requires first-launch account/provider setup. Sign into Toolbox and install IntelliJ IDEA/WebStorm there. Sign into each harness individually when it does not use the hub; Unix CodeRabbit uses `coderabbit auth login`.

### [UNVERIFIED] installer coverage

No software was installed on BEAST to test this change. Official assets and registry pins were resolved, templates parsed, and dry paths exercised. Actual winget upgrades/UAC, Maven extraction, native harness installers, npm installs, mise tool downloads, CodeRabbit installation, desktop downloads/first launch, macOS DMG mounting, and Linux desktop runtime dependencies remain untested. macOS and Linux desktop paths were rendered and syntax-checked using synthetic platform data, not run on those operating systems. See `docs/research.md` for sources and exact validation.
