# Set up this device

Clone and read the runbook while the owner bootstraps. On Windows, wait for both owner winget installs to finish before starting the tools stage; concurrent MSI installs can fail with error 1618. Tool installation does not wait for 1Password provisioning, Tailscale sign-in, or the hub. Never send credentials in chat or terminal output.

1. The owner chooses the device remark, then starts [Tailscale](#install-tailscale) and [1Password CLI](#install-1password-cli) installation in their own terminal. Use the lowercase hostname, or `<hostname>-wsl` for WSL. Windows and WSL have separate keys, vaults, and tokens. A hub rebuild also follows `hub/cliproxyapi/README.md`.
2. The agent clones this public repository, reads `AGENTS.md` and `docs/layout.md`, and runs the [tools stage](#agent-steps). On Windows, wait until the owner confirms both bootstrap winget commands have exited successfully. Tailscale sign-in can follow later. Default to all four harnesses and **yes** for system packages. The owner approves UAC prompts on Windows. On Unix, the owner runs the opted-in stage in their own TTY after `sudo -v`. The `server` role never uses sudo or system packages.
3. After the tools stage, provision 1Password access. For a client device, on BEAST create `agent-env-<remark>` and mint a unique key with `mint_client_key.py <remark> --vault agent-env-<remark>`. Check both exit statuses, then restart EasyCLIProxyAPI. Follow [Provision a device without recurring prompts](https://github.com/lees-dev/agent-env/blob/main/docs/cpa.md#provision-a-device-without-recurring-prompts).
4. In their BEAST terminal using their account session, the owner approves creation of the device's service account: read-only on its own vault, read+write on the shared vault `agent-repos`. Pipe its token into a temporary item in the owner's private 1Password vault using the documented stdin template. Never grant that vault to the device account.
5. On the device, the owner copies the token from the 1Password app into the documented no-echo prompt. Persist it in the Windows User environment or a Unix user-owned mode-0600 token file. Clear the clipboard and archive the transfer item. The agent continues without restarting. Account mode is opt-in.
6. The agent follows the remaining runbook: preflight, init, backup, apply, and verify. Keep the same system-package opt-in for apply. Secrets and hub wiring are installed only here.

These owner bootstrap commands work from any directory, before a checkout exists. On a `server` role, have the administrator install missing system prerequisites and Tailscale; the agent never uses sudo there.

## Install Tailscale

Windows, in the owner's normal PowerShell terminal:

```powershell
winget install --id Tailscale.Tailscale --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw 'Tailscale install failed' }
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
tailscale up
```

Linux and WSL Ubuntu, in the owner's terminal (https://tailscale.com/download/linux): install curl and CA certificates first if missing, using `sudo apt update && sudo apt install curl ca-certificates` on Debian/Ubuntu or `sudo dnf install curl ca-certificates` on Rocky/RHEL. Then:

```sh
(
  set -e
  ts_tmp=$(mktemp -d)
  trap 'rm -rf "$ts_tmp"' 0
  trap 'exit 1' HUP INT TERM
  curl -fsSL https://tailscale.com/install.sh -o "$ts_tmp/install.sh"
  sh "$ts_tmp/install.sh"
  sudo tailscale up
)
```

WSL on the hub host can use the documented mirrored-loopback route instead of its own Tailscale node. On other WSL devices, install and sign in within WSL as above.

macOS: install the standalone app from https://tailscale.com/download/mac and approve its network extension in System Settings. If Homebrew is already installed and no Tailscale app exists, `brew install --cask tailscale-app` installs it. Run `open -a Tailscale` and sign in through the menu-bar app. Do not replace an existing App Store or standalone install with Homebrew.

## Install 1Password CLI

Windows:

```powershell
winget install --id AgileBits.1Password.CLI --version 2.41.1 --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw '1Password CLI install failed' }
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
$null | op --version
```

Linux and WSL: install curl, CA certificates, and unzip if missing using `sudo apt update && sudo apt install curl ca-certificates unzip` on Debian/Ubuntu or `sudo dnf install curl ca-certificates unzip` on Rocky/RHEL. macOS includes curl and unzip. Then use the vendor archive on any of these Unix systems (https://developer.1password.com/docs/cli/get-started/):

```sh
export PATH="$HOME/.local/bin:$PATH"
(
  set -e
  op_version=2.41.1
  case "$(uname -s)" in Darwin) op_os=darwin ;; Linux) op_os=linux ;; *) exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) op_arch=amd64 ;; arm64|aarch64) op_arch=arm64 ;; *) exit 1 ;; esac
  op_tmp=$(mktemp -d)
  trap 'rm -rf "$op_tmp"' 0
  trap 'exit 1' HUP INT TERM
  curl -fLS "https://cache.agilebits.com/dist/1P/op2/pkg/v${op_version}/op_${op_os}_${op_arch}_v${op_version}.zip" -o "$op_tmp/op.zip"
  unzip -q "$op_tmp/op.zip" -d "$op_tmp"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$op_tmp/op" "$HOME/.local/bin/op"
  export PATH="$HOME/.local/bin:$PATH"
  op --version </dev/null
)
```

The parentheses keep failures and Ctrl-C inside the bootstrap command. They leave the owner's shell open.

## Agent steps

Then carry out these steps:

1. Locate the checkout. If you are not already inside a checkout of `https://github.com/lees-dev/agent-env`, clone that public URL to `~/agent-env` without GitHub authentication. First install Git if it is missing: Windows `winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity`; Debian or Ubuntu `sudo apt update` then `sudo apt install git`; Fedora or RHEL `sudo dnf install git`; macOS `brew install git`, or `xcode-select --install` when Homebrew is absent. Let the owner complete any installer or administrator prompt. After Windows winget installs Git, refresh PATH in that same PowerShell process before retrying:

   ```powershell
   $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
   git --version
   ```

   Refresh PATH again in every fresh agent shell after any winget install (`op`, chezmoi, Python included); an existing agent host has a stale environment. On Unix install curl first if missing, as in AGENTS.md step 1, and prepend `~/.local/bin` after installing chezmoi. Then run `git clone https://github.com/lees-dev/agent-env ~/agent-env` in a POSIX shell, or `git clone https://github.com/lees-dev/agent-env "$HOME/agent-env"` in PowerShell. If the destination exists, verify its remote before using it; never overwrite it. Change into the verified checkout.
2. Read `AGENTS.md` and `docs/layout.md`. Confirm role and machine remark first, then run the tools stage before any provisioning, preflight, or normal chezmoi init. Choose `client` unless the owner explicitly names this device as the hub. Use `server` for a headless user-level-only device. WSL installs Unix tools and uses the Windows T3 app.

   Windows, after the owner's bootstrap winget installs have finished, from a normal terminal (never the Claude desktop MSIX app):

   ```powershell
   $env:AGENT_ENV_SYSTEM_PACKAGES = '1'
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-tools.ps1 -Role client -Machine <remark>
   if ($LASTEXITCODE -ne 0) { throw 'Tools stage failed' }
   $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
   $env:JAVA_HOME = [Environment]::GetEnvironmentVariable('JAVA_HOME','User')
   if (-not $env:JAVA_HOME) { $env:JAVA_HOME = [Environment]::GetEnvironmentVariable('JAVA_HOME','Machine') }
   ```

   Linux, WSL, or macOS, in the owner's own terminal for sudo:

   ```sh
   (
     sudo -v || exit 1
     AGENT_ENV_SYSTEM_PACKAGES=1 sh scripts/install-tools --role client --machine <remark> || exit 1
   )
   . "$HOME/.config/agent-env/env.d/10-packages.sh"
   ```

   For `server`, omit `sudo -v` and run `sh scripts/install-tools --role server --machine <remark>`. Never enable system packages there. On Windows use `-Role server`; the entry point forces the opt-in off. If the owner declines system packages on a desktop, explain which dependencies remain and do not report setup complete until verify passes.

   The stage bootstraps the pinned chezmoi when absent, then runs the same package scripts as apply through an explicit secret-free allowlist. It never renders the main source tree or uses `AGENT_ENV_NO_SECRETS`. All four harnesses, T3 Code on desktop roles, and the development toolchain are installed before hub provisioning. The PATH hook and mise pins are deployed too. A later apply checks the same pins and leaves installed tools in place. See `docs/packages.md` for OS details and `[UNVERIFIED]` installer coverage.
3. Continue owner provisioning above, then follow `AGENTS.md` steps 1-7. Offer service mode with vault `agent-env-<remark>`, all four harnesses, system packages **yes**, and hub URL `https://beast-1.tail7f661e.ts.net`. Follow the documented WSL-on-BEAST loopback exception. A client never installs CLIProxyAPI. A hub rebuild uses service mode with vault `agent-env`.
4. Report the runbook's counts and remaining owner actions. By completion, the harnesses and toolchain must resolve on PATH and desktop apps must pass their metadata checks. Without hub authentication, sign into Claude Code, Codex, Grok, and Muse individually. Open T3 Code and complete its first-launch account/provider setup. Open Docker Desktop to approve its first-launch integration and start its engine. Sign into JetBrains Toolbox and install IntelliJ IDEA and WebStorm there. On Unix, run `coderabbit auth login` when needed. The tools stage does not perform these logins.
