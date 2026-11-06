# agent-env: runbook for the installing agent

This repo sets up a machine for agentic coding. It installs and configures the harnesses (Claude Code, Codex, Grok, Muse Code), the shared skills and global rules, and the client wiring to the CLIProxyAPI hub over Tailscale. It does this the same way on Windows native, WSL Ubuntu, Rocky/RHEL Linux and macOS.

chezmoi does the work. The source state lives in `home/` (`.chezmoiroot`). `docs/layout.md` says which directory each area owns and lists the naming rules and template data keys. Read it before you add or move a file.

`CLAUDE.md` only imports this file. Keep every instruction here.

## Never

- Never commit a secret, key, token, OAuth file, account email, log, runtime state or client data. Secrets come from 1Password at apply time (see "Secrets").
- Use service mode for agent work so it never needs desktop or Windows Hello approvals. Each client device gets its own service account: read-only on its `agent-env-<remark>` vault and read+write on the shared repo-credentials vault `agent-repos`, nothing else; never grant it owner-only vaults.
- Never run `chezmoi diff`, `chezmoi cat`, `chezmoi execute-template` or `chezmoi apply --verbose` on a target that renders a secret. They print it. Use `chezmoi status` and `chezmoi managed`, which print paths only.
- Never manage `~/.claude.json`, `~/.claude/skills/synced/`, `~/.claude/plugins/` (caches, `synced/`, `plugin-directory-bindings.json`), `~/.codex/skills/.system/`, or any `auth.json` / `.credentials.json`. `home/.chezmoiignore` blocks them.
- Never overwrite a harness's own config file. Merge it with a `modify_` script, or seed it once with `create_`.
- Never install system units or use `sudo` on the `server` role. It is user-level only.
- Never install `node_modules` or build across the Windows/WSL boundary. Windows and WSL are separate machines here, each with its own chezmoi config.
- Run Windows scripts through `powershell -NoProfile -ExecutionPolicy Bypass -File`; never dot-source a `.ps1` in the agent or owner session. Entry points may dot-source their own libraries inside that child process.
- Never write a backup inside this repo. Backups go to `~/.agent-env-backups/<UTC timestamp>/`.

## Runbook: "set up this machine"

Follow these steps in order. Stop at the first failure, say what failed (counts and check names only), and wait for the owner.

### 0. Ask

Ask the owner these questions in one message. Offer the detected value or the default for each one.

1. **Role.** The default is `client`: a workstation that uses the hub on BEAST and never installs the proxy. Never select `hub` unless the owner explicitly says this machine is the proxy host or BEAST is being rebuilt. For `hub`, read `hub/cliproxyapi/README.md` for setup or restore. `server` is a headless, user-level-only client.
2. **OS.** Confirm the detected flavour: `windows`, `wsl`, `linux` (Rocky/RHEL or Ubuntu) or `macos`. On Windows, WSL is a separate run inside WSL.
3. **Machine remark.** Lowercase `a-z 0-9 -`; the default is `<hostname>-wsl` on WSL and the hostname elsewhere. It names this machine's CPA client key and its 1Password item `cpa-client-<remark>`. Each machine has its own key, so never reuse another machine's remark.
4. **1Password access.** Default to `service` on every device: client-key vault `agent-env` on the hub, `agent-env-<remark>` on every other device. Before preflight, follow `docs/cpa.md` "Provision a device without recurring prompts". Choose the remark first, create its vault and mint its key on BEAST, then restart EasyCLIProxyAPI. In their own BEAST terminal, the owner approves creation of the device service account (read-only on its own vault, read+write on `agent-repos`) and stores its token in a temporary owner-only 1Password item via stdin. On the device, they copy it from the app into the no-echo prompt in their own terminal and persist it (Windows User environment or Unix user-owned mode-0600 token file). They archive the transfer item afterwards. The agent then continues without restarting; preflight, apply, and verify load the saved token when their process environment is empty. `account` is opt-in with vault `agent-env`.
5. **Harnesses.** Any of `claude, codex, grok, muse`. The default is all four.
6. **System packages.** May setup use winget per-machine installers with UAC, apt, dnf, or brew? When invoked through `setup.md`, default to **yes**: the owner is present to approve UAC or run sudo in their TTY. Set `AGENT_ENV_SYSTEM_PACKAGES=1` for the tools stage and step 5. Outside setup, ask before enabling it. Without approval, missing system dependencies remain and verify can fail, including Codex when Windows Node is absent. The `server` role never uses system packages (`docs/packages.md`).
7. **Hub URL.** The default is `https://beast-1.tail7f661e.ts.net`. The one exception is WSL on the hub host (Beast), which reaches CPA at `http://127.0.0.1:8317` through mirrored networking, under its own remark `beast-1-wsl` (`docs/cpa.md`).

### 0a. Install tools before provisioning

After cloning and confirming role, OS, remark, and system-package approval, run the secret-free stage before question 4's provisioning work:

```sh
AGENT_ENV_SYSTEM_PACKAGES=1 sh scripts/install-tools --role <role> --machine <remark>
```
```powershell
$env:AGENT_ENV_SYSTEM_PACKAGES = '1'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-tools.ps1 -Role <role> -Machine <remark>
```

On Unix with system packages, the owner runs this in their own TTY after `sudo -v`. On `server`, omit sudo and the opt-in. The stage installs all four harnesses, the development tools, and desktop apps on client/hub roles (WSL uses the Windows apps). It bootstraps chezmoi and uses only the package allowlist; no 1Password, Tailscale connection, or hub is needed. Do not wait for provisioning to run it. See `docs/packages.md` for prerequisites, dry runs, and untested platforms.

Then complete question 4's provisioning before step 1. The normal apply keeps the same lists and pins consistent.

### 1. Install the pinned 1Password CLI, then preflight

Install the version in `versions.toml` `[tools.op]` before preflight. Windows:

```powershell
winget install --id AgileBits.1Password.CLI --version <version> --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw '1Password CLI install failed' }
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
$null | op --version
```

Linux, WSL, and macOS use the pinned vendor zip (https://developer.1password.com/docs/cli/get-started/). Install `curl`, CA certificates, and `unzip` first if absent: the owner runs `sudo apt update && sudo apt install curl ca-certificates unzip` on Debian/Ubuntu, or `sudo dnf install curl ca-certificates unzip` on RHEL/Rocky. On `server`, have the administrator supply missing prerequisites; never use sudo. macOS includes curl and unzip.

```sh
export PATH="$HOME/.local/bin:$PATH"
(
set -e
op_version=$(awk '/^\[tools.op\]/{s=1;next} /^\[/{s=0} s&&/^version/{gsub(/.*= *"|".*/,"");print;exit}' versions.toml)
case "$(uname -s)" in Darwin) op_os=darwin ;; Linux) op_os=linux ;; *) exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) op_arch=amd64 ;; arm64|aarch64) op_arch=arm64 ;; *) exit 1 ;; esac
op_tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$op_tmp"' 0
trap 'exit 1' HUP INT TERM
curl -fLS "https://cache.agilebits.com/dist/1P/op2/pkg/v${op_version}/op_${op_os}_${op_arch}_v${op_version}.zip" -o "$op_tmp/op.zip" &&
  unzip -q "$op_tmp/op.zip" -d "$op_tmp" &&
  mkdir -p "$HOME/.local/bin" && install -m 755 "$op_tmp/op" "$HOME/.local/bin/op" || exit 1
export PATH="$HOME/.local/bin:$PATH"
op --version </dev/null
)
```

The owner completes token entry and persistence in their own terminal as in question 4 and `docs/cpa.md`, before these commands. Never ask for a token in chat. Then run the read-only preflight:

```sh
scripts/preflight --role <role> --machine <remark>                    # WSL, Linux, macOS
```
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/preflight.ps1 -Role <role> -Machine <remark>   # Windows
```

Preflight loads the saved service token and CPA_APP_DIR override into its process without printing it; it writes nothing. It checks the platform, LF line endings in this checkout, chezmoi, the 1Password CLI and its sign-in, vault access and this machine's item, whether Tailscale is up, whether the hub answers, and the harness versions against `versions.toml`. Each area adds its own checks in `scripts/preflight.d/`.

- **FAIL**: stop and report it. If token entry is needed, the owner uses their own terminal and the no-echo persistence procedure in `docs/cpa.md`. The agent reruns preflight without a restart. Do not sign in for the owner or request credentials in chat.
- **WARN**: list these for the owner. Apply fixes missing managed tools and version drift. A missing private hub script needs the owner's private backup; moving an installation out of Downloads is a separate manual step.

### 2. Install the pinned chezmoi

Take the version from `versions.toml` `[tools.chezmoi]`. Both installers verify checksums.

```sh
(sh -c "$(curl -fsLS https://get.chezmoi.io)" -- -b "$HOME/.local/bin" -t v<version>)
export PATH="$HOME/.local/bin:$PATH"                                    # same shell, before retry
```
```powershell
winget install --id twpayne.chezmoi --version <version> --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw 'chezmoi install failed' }
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
```

Then rerun preflight. The chezmoi line must say OK. Each fresh Unix agent shell must also prepend `~/.local/bin` to PATH until apply deploys the shell hook. Each fresh Windows shell must refresh Machine + User PATH from the registry before any retry; preflight and verify do this themselves. This applies after every winget install, including Git, `op`, chezmoi, and Python.

### 3. Initialise (no changes to home yet)

The answers come from environment variables, so nothing prompts:

```sh
(
export PATH="$HOME/.local/bin:$PATH"
. scripts/lib/load-token.sh
. scripts/lib/load-cpa-dir.sh
ae_load_cpa_dir || exit 1
ae_load_token <account|service> || exit 1
AGENT_ENV_ROLE=<role> AGENT_ENV_MACHINE=<remark> AGENT_ENV_OP_MODE=<account|service> \
AGENT_ENV_OP_VAULT=<agent-env for hub/account, agent-env-<remark> for other service devices> AGENT_ENV_CPA_URL=<hub url from question 7> \
AGENT_ENV_HARNESSES=claude,codex,grok,muse \
  chezmoi init --source "$PWD" || exit 1
chezmoi status || exit 1
chezmoi managed --include=files | wc -l
)
```
```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
$opMode = 'service' # Use the mode chosen in step 0; account mode is opt-in.
if ($opMode -eq 'account') { Remove-Item Env:OP_SERVICE_ACCOUNT_TOKEN -ErrorAction SilentlyContinue }
if ($opMode -eq 'service' -and -not $env:OP_SERVICE_ACCOUNT_TOKEN) { $env:OP_SERVICE_ACCOUNT_TOKEN = [Environment]::GetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN','User') }
if (-not $env:CPA_APP_DIR) { $env:CPA_APP_DIR = [Environment]::GetEnvironmentVariable('CPA_APP_DIR','User') }
$env:AGENT_ENV_ROLE='<role>'; $env:AGENT_ENV_MACHINE='<remark>'; $env:AGENT_ENV_OP_MODE=$opMode
$env:AGENT_ENV_OP_VAULT='agent-env-<remark>'; $env:AGENT_ENV_CPA_URL='<hub url from question 7>'   # hub: agent-env
$env:AGENT_ENV_HARNESSES='claude,codex,grok,muse'
chezmoi init --source (Get-Location).Path
if ($LASTEXITCODE -ne 0) { throw 'chezmoi init failed' }
chezmoi status
(chezmoi managed --include=files | Measure-Object).Count
```

Never set `AGENT_ENV_NO_SECRETS` here. It is the test mode for throwaway destinations only, and every command refuses it on the real home (see "Testing a change").

These blocks show status paths and the managed-file count with the saved environment loaded. If you run status in a fresh shell, repeat the loaders first. Wait for an OK before step 4.

### 4. Back up

```sh
scripts/backup            # or: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
```

This copies every managed target, and every path in `scripts/backup.d/*.list`, to `~/.agent-env-backups/<UTC timestamp>/` with a `manifest.tsv`. Report the counts it prints.

### 5. Apply

```sh
(
export PATH="$HOME/.local/bin:$PATH"
. scripts/lib/load-token.sh
. scripts/lib/load-cpa-dir.sh
ae_load_cpa_dir || exit 1
ae_load_token <account|service> || exit 1
# With question 6 opt-in, the OWNER adds these before apply:
# sudo -v || exit 1
# export AGENT_ENV_SYSTEM_PACKAGES=1
chezmoi apply --force --no-tty
)
```
```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
$opMode = 'service' # Use the mode chosen in step 0; account mode is opt-in.
if ($opMode -eq 'account') { Remove-Item Env:OP_SERVICE_ACCOUNT_TOKEN -ErrorAction SilentlyContinue }
if ($opMode -eq 'service' -and -not $env:OP_SERVICE_ACCOUNT_TOKEN) { $env:OP_SERVICE_ACCOUNT_TOKEN = [Environment]::GetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN','User') }
if (-not $env:CPA_APP_DIR) { $env:CPA_APP_DIR = [Environment]::GetEnvironmentVariable('CPA_APP_DIR','User') }
# With question 6 opt-in, the owner adds this before apply:
# $env:AGENT_ENV_SYSTEM_PACKAGES = '1'
chezmoi apply --force --no-tty                                          # Windows, normal terminal
```

On Linux, WSL, and macOS, sudo needs a TTY. With system packages opted in, the owner runs the apply in their own terminal using the full loader block above, or installs the packages from `packages/apt.txt`, `packages/dnf.txt`, or `packages/Brewfile` first. An agent's non-TTY shell cannot supply sudo credentials. The `server` role stays user-level only.

The run scripts go in this order: `10`-`14` packages (the PATH hook, system packages, development tools, harness binaries, and desktop apps at their pins), then the files, then `20` the skill links, `31`-`33` harness (Claude MCP servers, Claude plugins, Muse auth from the token helper) and, on the hub only, `40` the rebalancer task.

- `--force` is safe only because step 4 just ran. Never pass it without a backup from this session.
- On Windows, run this from a normal terminal, not from inside the Claude desktop app. That app is an MSIX package, which silently redirects `%APPDATA%` and `%LOCALAPPDATA%` writes into the package. Preflight warns when you are inside it.
- A failing `run_` script stops the apply. Report the script name and its exit status, fix the cause, then rerun steps 4 and 5.

### 6. Verify

```sh
scripts/verify            # or: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

Verify confirms that `chezmoi verify` is clean, that each chosen harness runs at its pin and that a backup exists. It then runs each area's checks in `scripts/verify.d/`: skill links, harness wiring, an authenticated hub probe that prints the status code only, and packages. Every FAIL must be fixed. Never weaken a check to make it pass.

Preflight and verify load CPA_APP_DIR when unset, from the Windows User environment or the Unix path environment file documented in docs/cpa.md. The init/status/apply blocks above do the same.

In service mode, keep the persisted token after verify. Preflight, the apply command above, and verify load it in their own processes without restarting the agent. Unix shells also load it through `~/.config/agent-env/env.sh`; see `docs/cpa.md` for hosts without shell startup files.

To roll back a file, copy it back from `~/.agent-env-backups/<ts>/<path>`; `manifest.tsv` lists the paths and hashes. Then fix the source, or the next apply makes the same change again. `scripts/backup.d/` lists the files that run_ scripts change outside chezmoi, and the backup covers those too.

### 7. Report

Give the owner the counts only: checks ok/warn/fail, files backed up, files applied, and what is left for them to do. The usual one-time items:

- `tailscale up` on a new machine. The tailnet policy in `tailscale/policy-snippet.hujson` needs the owner's review before anyone applies it (`docs/cpa.md`).
- Minting this machine's key on the hub (`~/.cpa-tools/mint_client_key.py`, `docs/cpa.md`), when preflight found no `cpa-client-<remark>` item.
- Without the hub, sign into each harness separately. Complete T3 Code first launch, Docker Desktop first launch, and JetBrains Toolbox sign-in and IDE installation on desktop roles.
- `codex mcp login linear`, once per machine. Codex MCP servers are set in `config.toml`, not with `codex mcp add`, which starts a blocking OAuth flow.
- In Muse, `/rules import` once (pick the Codex file), and again after the rules change (`docs/skills.md`).

## Updating a machine later

Edit the source in this repo, never the deployed file. Then:

1. Run `sh scripts/check.sh` and commit (see "Working in this repo").
2. On each machine, run `git pull`. If `home/.chezmoi.toml.tmpl` changed, repeat step 3 (`chezmoi init --source` with that machine's existing answers and persisted-environment loaders).
3. Then run steps 1, 4, 5, and 6 above, including both persisted-environment loaders for apply.

Config template changes take effect only after init. Existing Linux client/hub machines must reinitialize to replace the old `headless = true` value before desktop installation and T3 configuration can run.

`chezmoi apply` re-runs a `run_onchange_` script only when its rendered contents change. Each one embeds the hash of the file it acts on, so editing `versions.toml` or a package list re-runs the matching install.

## Secrets

- 1Password is the only source. Templates read secrets only through partials in `home/.chezmoitemplates/secrets/`, which call `onepasswordRead "op://<vault>/<item>/<field>"`. A source file that includes one must be a `private_` target (mode 0600) or a `run_` script. `scripts/secret-guard.sh` enforces both rules.
- Each machine has one CPA client key, in item `cpa-client-<machine remark>`, field `credential`. The hub mints a new key for each new machine (`docs/cpa.md`). Never copy one machine's key to another.
- Vaults: `agent-env` holds hub-side and opt-in account-mode client keys. Every other service device reads only `agent-env-<remark>` for its key, and reads and writes the shared vault `agent-repos` for repositories' development credentials (never production values). An owner-only admin vault is never shared with device service accounts. See `docs/cpa.md` "1Password vaults".
- chezmoi writes the key to `~/.config/agent-env/cpa-key` (mode 0600) at apply time. The harnesses run the token helper (`~/.config/agent-env/cpa-token`, or `cpa-token.cmd` on Windows), which prints that file. So 1Password is needed at apply time only, never per harness call, and no harness config holds the key. A rotation needs a new apply, which also re-runs the Muse auth script, because that script embeds the SHA-256 of the key (`docs/cpa.md`).
- `onepassword.prompt = false`: chezmoi never starts a sign-in in the middle of an apply. Preflight proves the session first.
- Persist service tokens for the user by owner decision of 2026-11-05: Windows USER `OP_SERVICE_ACCOUNT_TOKEN`, or Unix mode-0600 `~/.config/op/agent-env-token` loaded by a mode-0600 env.d snippet. Follow `docs/cpa.md` for no-echo entry and persistence. Never put values in rc files, history, command arguments, chat, repo files, or backups. Keep the persisted token after verify so agents never prompt.
- Pass explicit stdin to every scripted `op` invocation: `/dev/null`, a closed PowerShell pipeline (`$null | op ...`), or the JSON item template. An inherited open pipe can hang `item edit` or disrupt `item get` and `read`.
- Print counts, status codes and check names. Never print a value, an account email or a log line. If a command might print one, send its output to the null device.
- If a secret reaches git, stop. Tell the owner, rotate the secret, and purge it from history before any push.

## Transport (fixed by the owner, 2026-11-04)

- Every client uses the Tailscale serve URL `https://beast-1.tail7f661e.ts.net`. Claude-style clients use it without `/v1`. OpenAI-style clients add `/v1`. A tailnet grant restricts it to the owner's devices (`tailscale/`, `docs/cpa.md`).
- The CPA management API stays loopback-only on the hub.
- The hub stays on Beast. Private integrations stay in their owning repositories.

## Working in this repo

### Checks before every commit

```sh
sh scripts/check.sh       # secret guard, sh -n (+ shellcheck), PowerShell parse + ASCII-only, template render
```

### Testing a change

Render and apply the whole tree into a throwaway destination, without 1Password and without touching the real home (`docs/testing.md`):

```sh
sh scripts/render-test.sh          # Git Bash on Windows, then inside WSL; also Linux and macOS
```

It inits chezmoi with a scratch config, state and cache and `AGENT_ENV_NO_SECRETS=1`, applies with `--exclude=scripts`, checks idempotence and the placeholder key, renders every run script and parses it, and fails if `op` is ever called. Run it on Windows and in WSL before you commit a change to `home/`.

CI (`.github/workflows/secret-scan.yml`) runs gitleaks over the full history, then `scripts/secret-guard.sh` and `scripts/check.sh`.

### Conventions

- LF line endings everywhere (`.gitattributes`). The only exception is `*.cmd` / `*.bat`, which are CRLF in the working tree because `cmd.exe` needs it.
- POSIX `sh` for Unix scripts (no bashisms). Every `.ps1` must run on Windows PowerShell 5.1 and be ASCII only.
- Windows PowerShell 5.1 strips embedded double quotes from arguments it passes to native programs. Write chezmoi template arguments without `"` (for example `'{{ .role }}'` or `'{{ range .harnesses }}{{ . }} {{ end }}'`).
- Test against throwaway copies only. Put downloads, fake homes and scratch configs under `.tools/` (gitignored), and delete them when you are done.
- Resolve every version from its registry on the day you change it, record it in `versions.toml`, and cite the primary docs URL in `docs/research.md`. Mark anything you could not test `[UNVERIFIED]`.
- Commit messages say what changed and why, and end with the trailer your harness requires.
- This repo has no Linear tickets.

<!-- The next section is copied verbatim from home/dot_agents/docs/agents/pr-standards.md (deployed to ~/.agents/docs/agents/pr-standards.md). Change both in the same commit. -->

## Engineering standards for every repo (owner, 2026-11-05)

These apply in every repository and to every agent harness: Claude Code, Codex, Grok, Muse Code and any other. A repo's own AGENTS.md, CLAUDE.md, PR template and gate docs supply facts (gate, sensitive paths, size limit, merge method and identity, release step, per-worktree resources) and may add stricter checks; they never override process (CI waits, merge queues, agent tooling, worktrees, cleanup, credentials, landing). See the repo-defaults rules. The full procedure is in the `pr-workflow` skill (`~/.agents/skills/pr-workflow/SKILL.md`, also `~/.claude/skills/pr-workflow`). Load it before briefing anyone to build a PR, and before opening, pushing to, updating, landing or cleaning up any pull request.

- **No CI: every check runs locally before the PR opens; open, then land it with `land-pr`** (pr-workflow sections 1–4). One branch per issue/ticket. Nothing waits on GitHub CI.
  - Before opening, run on the committed head: the repo's lint, typecheck, build, and the tests the change reaches (the repo's single gate or affected-tests command when it has one, e.g. `npm run gate`; otherwise its full test command), plus only the browser/E2E specs the change adds or edits. Wide browser sweeps run on main every few merges, not before each PR.
  - Review before opening: the CodeRabbit CLI once when the repo has `.coderabbit.yaml` (`coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"`; Linux/macOS only, so from Windows run it in WSL from a clone whose `origin` is the GitHub URL), and the model review `subagent-routing` sets, started with `delegate_task` in T3: one focused cross-family reviewer by default (GPT Sol for Claude-built work, Opus for GPT-built work), whatever the change's line or file count, plus a second family when it touches security, auth, data loss, migrations or concurrency; the four-model review panel (GPT Sol, Muse Wonder Full, Grok 4.7, Sonnet) only for complex new behavior or a sensitive path in Opus-built work. Fix every Critical, Major, P0 and P1, recommit, and rerun.
  - Every builder brief, whether for you, a subagent or a workflow agent, carries the repo's rules for the paths it will touch: `.coderabbit.yaml` path instructions, the pre-push checklist, size limit and sensitive paths.
  - Open the PR once, ready (not draft), with the local results in its body, a `Linear-Priority: <0-4>` line, and `Depends-on: #n` when it needs another PR first. Then land it with `land-pr <n> --sha <gated sha>` (`node ~/.agents/bin/land-pr.mjs`): it prints `MERGED <sha>`, `QUEUED <pos>`, `QUEUE-FULL <pos>` or `REFUSED <reason>`. The landing rules (outcomes, kicking the repo's lander, the queue labels and who sets them, editing a queued PR, bounces, when the work is done, and the fallback when `land-pr` or the lander is missing) live in one place: `pr-workflow` section 4. A PR is done when it is merged. No `--auto`, no GitHub merge queue, no `--admin`, no waiting on CI.
  - A repo that still has GitHub CI: treat it as advisory, never wait on it or add to it. Next time work happens there, tell the owner, then remove it in a separate small PR (delete PR/merge CI workflows and required checks, keep release/deploy workflows, add a single local gate command). If its required checks block that removal PR, let them run that one time.
  - Production stays behind the repo's release/approval step where one exists. Never promote to production without the owner's explicit approval.
- **Clean up once a PR merges or closes** (pr-workflow section 7). Remove everything the work created, wherever it ran:
  - local and remote worktrees and their branches;
  - server checkouts, proof and review dirs, and helper refs (`prove/*`, `cr/*`);
  - test databases, containers and volumes;
  - scratch folders and temp files;
  - watchers, monitors and background jobs.

  Clean up only after the merge. First confirm the PR state, and that nothing is dirty or unpushed: HEAD counts as pushed when it equals the PR head, OR its sha appears in a `Gate: pass @ <sha>` line of the PR body, OR `git range-diff` shows the same patches as the merged PR head, OR it has no commits outside the remotes. Never remove a worktree whose PR carries a queue label (`queued`, `landing`, `queue-blocked`, `queue-hold`, `queue-waiting`), or anything an open PR, a stacked branch or a running job uses, or any production data. In T3, `agent-worktree teardown` (on settle) and `agent-worktree sweep` do this automatically. Report what was removed, counts only.

### What the standards mean in this repo

- CodeRabbit is enabled at the organization level (CHILL profile, Advanced plan); there is no `.coderabbit.yaml`. Its `CHANGES_REQUESTED` review blocks merging, including actionable Minor findings.
- Before opening or pushing a PR, run `sh scripts/check.sh` and `sh scripts/render-test.sh` in Git Bash and WSL. Then run `coderabbit review --agent --deep --gate major --committed --base-commit "$(git merge-base origin/main HEAD)"` on the committed head on a Linux host (WSL on Windows), with `origin/main` fetched from GitHub. Require two independent clean runs on the final head. Fix all Critical/Major and actionable Minor findings, for at most three fix rounds. The cross-family model review still applies to every PR.
- A PR touches one area (`docs/layout.md`). The foundation files (`scripts/lib/`, `.chezmoi.toml.tmpl`, the CI workflow) change in their own PR.
- After a merge, also delete any `.tools/` downloads and scratch chezmoi configs you made for testing.
