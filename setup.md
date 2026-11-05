# Set up this device

The owner completes these steps in order, in their own terminals. Never send credentials in chat or terminal output.

1. Choose the device remark before provisioning. Use the lowercase hostname, or `<hostname>-wsl` for WSL on every PC. Windows and WSL have separate keys, vaults, and tokens.
2. [Install Tailscale](#install-tailscale) for this OS, then sign the device into the tailnet.
3. [Install 1Password CLI 2.41.1](#install-1password-cli-2411) for this OS. This is the pin in `versions.toml` `[tools.op]`. Default to service mode. A hub rebuild follows `hub/cliproxyapi/README.md` first, with client-key vault `agent-env`.
4. For every other device, on BEAST create `agent-env-<remark>` and mint a unique key with `mint_client_key.py <remark> --vault agent-env-<remark>`. Check both exit statuses, then restart EasyCLIProxyAPI to reload its keys. Follow [Provision a device without recurring prompts](https://github.com/lees-dev/agent-env/blob/main/docs/cpa.md#provision-a-device-without-recurring-prompts).
5. In an owner terminal on BEAST using their account session, approve creation of the device's read-only service account. Pipe the returned token into a temporary item in the owner's private 1Password vault using the documented stdin template. Never grant that private vault to the device account.
6. On the device, copy the token from the 1Password app into the documented no-echo prompt in the owner's terminal. Persist it in the Windows User environment or a Unix user-owned mode-0600 token file. Clear the clipboard and archive the transfer item in the app. The agent then continues without restarting: preflight, the documented apply command, and verify load the persisted token for their own process when the environment value is empty. Account mode is opt-in.
7. Decide whether to opt in to system packages. After the agent has cloned, initialised, and backed up the device, run an opted-in Unix apply in the owner's terminal because sudo requires a TTY. The `server` role never uses sudo.

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

## Install 1Password CLI 2.41.1

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
2. Read `AGENTS.md` and the documents it requires. Follow its runbook in order, including preflight, approval, backup, apply, and verify. Treat every failure as the runbook directs.
3. Offer these defaults in the runbook's questions: role `client`, service mode with vault `agent-env-<remark>`, all four harnesses (`claude,codex,grok,muse`), and hub URL `https://beast-1.tail7f661e.ts.net`. Default the remark to `<hostname>-wsl` on WSL and the hostname elsewhere. Follow the documented WSL-on-BEAST loopback exception when applicable. A client uses the existing hub; it never installs CLIProxyAPI or uses `hub/cliproxyapi/`. Select `hub` only when the owner explicitly says this device is the proxy host or BEAST is being rebuilt. In that case, read `hub/cliproxyapi/README.md` too and use service mode with vault `agent-env`.
4. Report the runbook's result counts and any remaining owner actions. Never print secrets, account emails, or logs.
