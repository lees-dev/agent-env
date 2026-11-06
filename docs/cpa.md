# CLIProxyAPI hub and client wiring

CLIProxyAPI (CPA) fronts the owner's model access. It runs on Beast inside the EasyCLIProxyAPI GUI. Every harness on every machine sends its model calls to the hub with a client key. This page covers how clients reach the hub, where the keys live, and the hub's own tools.

Owner decisions of 2026-11-04 and 2026-11-05 fix the design. Anything not yet tested is marked `[UNVERIFIED]`.

To rebuild the proxy host, follow [Restore the hub after a format](../hub/cliproxyapi/README.md#restore-the-hub-after-a-format). Those configuration files are for `role hub` only. Normal clients never install the proxy.

## Topology

The restore baseline is EasyCLIProxyAPI 0.3.73 with CLIProxyAPI core 8.0.53 or 8.0.54. `versions.toml` records the observed core pin as 8.0.54. Confirm the installed versions when restoring the hub.

```
every client (Windows, macOS, Linux, WSL)            Beast (hub, tag:cpa-hub)
  harness --(helper prints the key)--> https://beast-1.tail7f661e.ts.net/v1  --serve-->  127.0.0.1:8317 CPA
                                         tailnet grant: owner's desktop/server devices only
  management API: loopback only, never mounted by serve
```

The rules:

1. **One URL.** Every client uses `https://beast-1.tail7f661e.ts.net`.
   - Claude-style clients take it without `/v1` (data key `cpaAnthropicBaseUrl`), because Claude Code adds `/v1/messages` itself.
   - OpenAI-style clients take it with `/v1` (data key `cpaOpenAIBaseUrl`): Codex, Grok and Muse.
   - Every path these clients call is under `/v1`: messages, responses, chat completions and models.
2. **Serve mounts `/v1` only.** Serve never mounts the management API (`/v8/management`). CPA and the GUI listen on 127.0.0.1 only. Preflight and verify check all three on the hub.
3. **A tailnet grant** opens the hub's tcp:443 only to the owner's desktop and server devices (`tailscale/policy-snippet.hujson`).
4. **One key per machine.**
   - The key's remark on the hub is the machine remark (the `machine` data key).
   - The key lives in 1Password as item `cpa-client-<remark>`, field `credential`. The vault depends on how the machine signs in to 1Password (see "1Password vaults").
   - A key is never copied to another machine, so each machine's key can be revoked on its own.
5. **No harness config holds a key.** On each apply, chezmoi writes the key to `~/.config/agent-env/cpa-key` (`private_`, mode 0600 on Unix). Harnesses run a helper that prints it:

| Harness | Base URL (data key) | Auth on Unix | Auth on Windows |
|---|---|---|---|
| Claude Code | `cpaAnthropicBaseUrl`, as `env.ANTHROPIC_BASE_URL` | `apiKeyHelper`: `<home>/.config/agent-env/cpa-token` (runs under `/bin/sh`) | `apiKeyHelper`: `%USERPROFILE%\.config\agent-env\cpa-token.cmd` (runs under `cmd`) |
| Codex | `cpaOpenAIBaseUrl`, as `model_providers.<id>.base_url` | `[model_providers.<id>.auth] command = "<home>/.config/agent-env/cpa-token"` | `command` = the `.cmd` helper [UNVERIFIED: Codex may need `command = "cmd"`, `args = ["/d", "/c", "<helper>"]`] |
| Grok | `cpaOpenAIBaseUrl`, as `[endpoints] cli_chat_proxy_base_url` | `[auth] auth_provider_command` = the sh helper | the `.cmd` helper |
| Muse Code | `cpaOpenAIBaseUrl`, as `endpoint_transport.base_url` (`auth = "bearer"`) | Muse reads its key from `auth.json`, which this repo never manages [UNVERIFIED: whether Muse can run a helper] | same |

The harness area writes those settings. This area owns the helper paths and what they print:

- On success, a helper prints the key on stdout, with no trailing newline and nothing else.
- When the key file is missing, a helper exits 1 with a message on stderr.

`apiKeyHelper` sends the key as both `X-Api-Key` and `Authorization: Bearer` (https://code.claude.com/docs/en/settings-reference#apikeyhelper). Whether CPA accepts both headers on one request is [UNVERIFIED]. If it does not, the harness area falls back to `env.ANTHROPIC_AUTH_TOKEN`, rendered from a `private_` template.

## 1Password vaults

A 1Password service account is granted whole vaults, not single items (https://developer.1password.com/docs/service-accounts/). Service mode is the default on every device, including desktops, so agent work never needs a desktop or Windows Hello approval. The hub uses an owner-provisioned credential for client-key administration; other devices get their own vault and service account. That service account also gets read+write on the shared vault `agent-repos`, which holds the repositories' non-production credentials. One shared vault means a new repository never needs a new token on any device.

| Vault | Holds | Who can read it |
|---|---|---|
| `agent-env` | Hub-side client keys and opt-in account-mode keys, field `credential` | The owner and hub |
| `agent-env-<remark>` | That one device's `cpa-client-<remark>`, field `credential`, nothing else | The device's service account (read-only) and the owner |
| `agent-repos` | Repositories' development and test credentials, items `<repo>-<service>-<env>` (`docs/lifecycle.md`). Never production values or client keys | Every device's service account (read+write) and the owner |
| Owner-only admin vault | Private administration and restore material | Never shared with device service accounts |

- **Hub service mode:** `role hub`, `AGENT_ENV_OP_MODE=service`, `opVault=agent-env`. The owner restores the hub service token privately when rebuilding.
- **Other devices:** `AGENT_ENV_OP_MODE=service`, `opVault=agent-env-<remark>` by default. Grant their service accounts `agent-env-<remark>` read-only and `agent-repos` read+write, nothing else. Never grant them any owner-only vault or `agent-env`. Keep one key and one service account per device, including BEAST's WSL, so revoking one device affects no other device.
- **Devices provisioned before `agent-repos`:** 1Password sets a service account's vault access when it is created (https://developer.1password.com/docs/service-accounts/get-started/) [UNVERIFIED that it can never be extended later]. Create a replacement service account with both grants as below, persist its token on the device in place of the old one, rerun preflight, then delete the old service account.
- **Account mode** is an opt-in (`AGENT_ENV_OP_MODE=account`) using desktop CLI integration or `op signin`. Its vault defaults to `agent-env`. Clear the service token from that process before using account mode. Desktop approvals are an explicit tradeoff of this opt-in.
- **Preflight** checks device service-account scope by counting accessible vaults and unexpected items, without reading fields or printing titles. It leaves `agent-repos` out of that count, does not scan its items, and warns when the device cannot reach it. The hub role is exempt from device scope restrictions. Owner-only vaults are never apply-time `opVault` values.

### Provision a device without recurring prompts

On the hub, provision `agent-env-<remark>` and mint its client key with the hub credential. Capture command output rather than displaying vault metadata:

```powershell
$null | op vault create agent-env-<remark> *> $null
py -I ~/.cpa-tools/mint_client_key.py <remark> --vault agent-env-<remark>
```

Check each exit status before continuing. The owner then creates the device's service account on BEAST, read-only on its own vault and read+write on `agent-repos` (https://developer.1password.com/docs/service-accounts/get-started/). This is the only 1Password approval needed for device provisioning. It needs the owner's account session, not a service token. In a separate owner terminal with `OP_SERVICE_ACCOUNT_TOKEN` removed from that process, capture the result in memory for private transfer to the new device, never in chat or terminal output:

```powershell
$deviceToken = ($null | op service-account create agent-env-<remark> --vault agent-env-<remark>:read_items --vault agent-repos:read_items,write_items --raw 2>$null) -join ''
```

If creation fails or returns an empty token, stop. Use a temporary item in the owner's private vault as the transfer channel. In the same owner terminal, pipe the item template on stdin, capturing the result without printing it:

```powershell
if ($LASTEXITCODE -ne 0 -or -not $deviceToken) { throw 'Device service-account creation failed' }
$transfer = @{
    title = 'Device setup <remark>'
    category = 'API_CREDENTIAL'
    fields = @(@{ id = 'credential'; type = 'CONCEALED'; label = 'credential'; value = $deviceToken })
}
$transferJson = $transfer | ConvertTo-Json -Depth 6 -Compress
$created = ($transferJson | op item create --vault '<owner-private-vault>' --format json - 2>$null) -join ''
if ($LASTEXITCODE -ne 0) { throw 'Private token transfer item creation failed' }
Remove-Variable deviceToken, transfer, transferJson, created
```

On the device, the owner opens that item in the 1Password app, copies the credential into the no-echo prompt below in their own terminal, and persists it. Then they clear the clipboard and archive the transfer item in the app. This private vault is never granted to the device service account. Do not send the token through chat or terminal output.

On the new device, the owner enters the token in their own terminal, without echo or shell history. Bash and zsh use the POSIX no-echo procedure below:

```sh
# Run in the owner's terminal, not an agent's non-TTY shell.
(
  set -e
  _saved_tty=$(stty -g)
  trap 'stty "$_saved_tty"' 0
  trap 'exit 1' HUP INT TERM
  stty -echo
  printf 'OP_SERVICE_ACCOUNT_TOKEN: ' >&2
  IFS= read -r OP_SERVICE_ACCOUNT_TOKEN
  printf '\n' >&2
  stty "$_saved_tty"
  [ -n "$OP_SERVICE_ACCOUNT_TOKEN" ] || exit 1
  umask 077
  mkdir -p "$HOME/.config/op"
  chmod 700 "$HOME/.config/op"
  printf '%s\n' "$OP_SERVICE_ACCOUNT_TOKEN" > "$HOME/.config/op/agent-env-token"
  chmod 600 "$HOME/.config/op/agent-env-token"
)
```
```powershell
$s = Read-Host -AsSecureString OP_SERVICE_ACCOUNT_TOKEN
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
try { $env:OP_SERVICE_ACCOUNT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); Remove-Variable s, bstr }
```

`$env:OP_SERVICE_ACCOUNT_TOKEN = '<token>'` is not safe: older PSReadLine saves that line to history. Likewise `export OP_SERVICE_ACCOUNT_TOKEN=<token>` lands in shell history. Never print a token or put its value in a command line, rc file, repo, or chat.

The Unix block above persists the token before its subshell ends. Ctrl-C restores echo and leaves the owner terminal open. On Windows, persist the token for that user before preflight:

```powershell
[Environment]::SetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN', $env:OP_SERVICE_ACCOUNT_TOKEN, 'User')
```

The agent now continues without a restart. Preflight, verify, and the documented apply command load the persisted token for their own process when `OP_SERVICE_ACCOUNT_TOKEN` is empty. Windows reads the User environment value; Unix accepts only a regular, non-symlink mode-0600 file owned by the current user. Nothing prints the token. Account mode skips this loading.

Apply also deploys a mode-0600 `~/.config/agent-env/env.d/40-cpa-op.sh` using the same checks through `env.sh`. The raw token file is unmanaged and excluded from backups. Keep the persisted token after verify. For a Unix process without shell startup files, source `~/.config/agent-env/env.sh` before launching it. A Windows host that needs the token directly can load the User environment value in that process. No agent restart is needed for the runbook commands.

Every scripted `op` call must receive explicit stdin: `/dev/null` on Unix, `$null | op ...` in PowerShell, or the JSON template for item creation. An inherited open pipe can make `op item edit` hang while it reads a template, and can disrupt `item get` or `read`.

## WSL on the hub host

From Beast's WSL, the connection to `https://beast-1.tail7f661e.ts.net` on TCP 443 is refused. From Windows, the same URL returns HTTP 401. Mirrored networking (`.wslconfig networkingMode=mirrored`, already set) shares Beast's loopback with WSL. So from WSL, `http://127.0.0.1:8317` answers HTTP 401 without a key (tested 2026-11-04).

Decision: WSL on the hub host is a hub-local client.

- Claude uses `http://127.0.0.1:8317`. The other harnesses use `http://127.0.0.1:8317/v1`.
- It has its own key, remark `beast-1-wsl`.

The template accepts `http://127.0.0.1:<port>` when `osFlavour` is `wsl`. Set `AGENT_ENV_CPA_URL=http://127.0.0.1:8317` on the hub-host WSL client.

The tailnet grant does not apply to loopback traffic. Preflight on WSL detects this case and prints a hint. The alternative is to run Tailscale inside WSL as a separate node. That is [UNVERIFIED] alongside mirrored networking, and not recommended.

## Tailnet policy

Apply `tailscale/policy-snippet.hujson` by hand. The file explains both the admin-console route and the API route. No API token ever goes in this repo. Check these points first:

- **Grants only allow.** While the default allow-all rule is in the policy, the snippet restricts nothing. Removing allow-all affects the whole tailnet. The snippet's `autogroup:member -> autogroup:self` grant keeps every user-owned device reaching every other.
- **Tagging Beast changes how it is treated.** As `tag:cpa-hub`:
  - Beast is no longer one of the owner's devices for `autogroup:self` or the default Tailscale SSH policy.
  - Its node key stops expiring.
  - The snippet grants it outbound access to the owner's devices. Review private integrations in their owning repositories.
  - Open any other inbound port you use on Beast in the commented grant.
- **Posture `posture:agent-os`** (`node:os IN ['windows', 'linux', 'macos']`) keeps phones and tablets off the hub. The `node:os` spellings for Windows and Linux are [UNVERIFIED]. If the tests fail on save, or verify fails, check the device's attributes in the admin console.
- **Check it after you apply it.** Preflight on the hub prints `this node carries tag:cpa-hub`, and verify on each client still gets HTTP 200.

## Tailscale serve

Check it on the hub (preflight does this too):

```powershell
tailscale serve status --json   # expect exactly one handler: "/v1" -> "http://127.0.0.1:8317/v1"
tailscale funnel status         # expect "(tailnet only)"
```

To recreate it after a reset, run this from a normal terminal on Beast (https://tailscale.com/kb/1242/tailscale-serve):

```powershell
tailscale serve --bg --https=443 --set-path=/v1 http://127.0.0.1:8317/v1
```

To remove only that mount, run `tailscale serve --https=443 --set-path=/v1 off`.

Never mount `/`: that serves the management API. Never turn on Funnel.

## Mint a key for a new machine

Run this on the hub with its client-key administration credential. Use the machine remark from that device's runbook step 0. Create its vault first ("Provision a device without recurring prompts").

```powershell
py -I ~/.cpa-tools/mint_client_key.py <remark> --vault agent-env-<remark> --dry-run
py -I ~/.cpa-tools/mint_client_key.py <remark> --vault agent-env-<remark>
```

For the hub itself or an opt-in account-mode machine, use `--vault agent-env`. Existing keys in `agent-env` stay there until each device's planned rotation. Never copy them into a new device's vault. The mint tool inherits `OP_SERVICE_ACCOUNT_TOKEN` and closes stdin on every `op` call except item creation, which receives its JSON template.

`mint_client_key.py` runs these steps in order and prints statuses only:

1. It checks that `op` is signed in, the vault is readable, and `cpa-client-<remark>` does not exist yet.
2. It generates the key in memory: `sk-cpa-` plus 42 random bytes, 63 characters in all.
3. It creates the item from op's own `API Credential` template, piped on stdin. A secret never goes on a command line, where other processes can read it (https://developer.1password.com/docs/cli/reference/management-commands/item/).
4. It reads the item back with `op read` and compares it with the key in memory.
5. It pipes the key into `add_client_key.py <remark>`, the existing tool. That tool backs up the GUI's `config.toml` and the core's `config.yaml` as `.bak-addkey-<remark>` in the install directory, then adds the key to both.

Next:

1. Restart EasyCLIProxyAPI, so that the core reloads its keys.
2. Run the runbook on the new machine. Its preflight confirms the item exists. Its verify proves the hub accepts the key: an authenticated `GET /v1/models` that prints the HTTP status and the model count.

If step 5 fails after the item is stored, register the stored key without displaying it:

```powershell
$null | op read op://<vault>/cpa-client-<remark>/credential | py -I ~/.cpa-tools/add_client_key.py <remark>   # <vault>: agent-env or agent-env-<remark>
```

`add_client_key.py` refuses a remark that is already in use, and a key that is already present.

## Rotate or revoke a key

1. On the hub, remove the key with that remark. Use either:
   - the GUI's client-key settings [UNVERIFIED], or
   - with the GUI stopped, a hand edit of both files after copying them: delete the entry in `api-keys` in `config.toml`, and the same key's line under `api-keys:` in `cpa-core/config.yaml`.
2. Restart the GUI. `py -I ~/.cpa-tools/list_client_keys.py` now lists the remaining remarks and shows `in_sync=true`.
3. In 1Password, archive item `cpa-client-<remark>`.
4. To rotate, run "Mint a key" again with the same remark. Then run `scripts/backup` and `chezmoi apply` on that machine.

That machine's harnesses get HTTP 401 from step 2 until its `chezmoi apply` in step 4.

## Hub tools (`~/.cpa-tools`, hub role only)

chezmoi deploys the three client-key scripts below from `home/dot_cpa-tools/`, plus their install-path configuration. Upstream-account tools are not distributed by this public repository.

- **Install directory.** Each script reads it from `CPA_APP_DIR`, or else from `app_dir` in `~/.cpa-tools/cpa-tools.toml`. That file is rendered from `CPA_APP_DIR` at apply time, falling back to `versions.toml` `[hub.easycliproxyapi] install_dir`. Persist a local override as shown in the hub README; never edit the checkout for a machine-local path.
- **No secrets in the scripts.** None of them contains a key or an email. They read the management key from the GUI's `config.toml` at run time.

| Script | What it does |
|---|---|
| `add_client_key.py <remark>` | The existing tool: adds a key read from stdin. It now also checks the remark and refuses duplicates |
| `mint_client_key.py <remark>` | Generates the key, stores it in 1Password, then runs `add_client_key.py` |
| `list_client_keys.py [--json]` | Prints remarks, key lengths and counts, and whether the GUI and core lists match. Verify uses it |

Two old scripts are retired and not deployed. The harness area's `modify_` scripts replace both. Delete the old copies from `~/.cpa-tools` once those scripts land.

- `point_clients.py` wrote the key into the Claude and Codex configs.
- `muse_settings.py` set the Muse endpoint.

Restore the optional `~/.cpa-tools/soonest_reset.py` from the owner's private backup. Its runtime files and private source are never managed or copied by this repo's backup. Preflight and verify WARN when it is absent.

Only when that script already exists, `run_onchange_after_40-cpa-rebalancer-task.ps1` keeps the scheduled task `CPA Soonest-Reset Rebalancer` as it is on Beast today:

- If the private script is missing, it WARNs with a pointer to the owner's private backup and leaves tasks alone. After restoring the script, rerun the rendered task script through `powershell -NoProfile -ExecutionPolicy Bypass -File <script-path>`. An unchanged `run_onchange_` script does not rerun on apply.
- It runs `pythonw -I ~/.cpa-tools/soonest_reset.py` every 5 minutes, with a 4-minute limit and `IgnoreNew`.
- It runs as the logged-on user, without elevation.
- It leaves a task that already matches alone. Beast's task matches (tested 2026-11-04).
- Before it replaces a task that differs, it exports that task to the backup root.

## Stable install path (documented, not done by apply)

Use a stable install location outside Downloads and synced folders. Moving an existing installation is a manual change that needs the owner's approval:

1. Run preflight and `scripts/backup.ps1`. Pick the new location, for example `~/.cpa/easycliproxyapi`: outside Downloads and outside any synced folder.
2. Turn off the GUI's `run-on-startup`, exit the GUI from its tray icon, and confirm that `http://127.0.0.1:8317` no longer answers. The rebalancer fails quietly until step 6.
3. Copy the folder with `robocopy <old> <new> /E /COPY:DAT /XJ`. It holds the OAuth files and every client key, so never copy it anywhere else.
4. If `auth-dir` (in the GUI's `config.toml`) or `oauth.auth-dir` (in the core's `config.yaml`) is an absolute path into the old folder, point it at the new one. Look at the key names only; do not print the values.
5. Start the GUI from the new folder and turn `run-on-startup` back on. Then check:
   - 127.0.0.1:8317 answers HTTP 401;
   - `list_client_keys.py`, with `CPA_APP_DIR` set to the new path, shows `in_sync=true`.
6. Set the user environment variable `CPA_APP_DIR` to the chosen absolute path, then load it into the apply process as shown in the hub README. Run `scripts/backup.ps1`, the runbook apply command, and verify. The checkout stays clean; the rebalancer and key-roster checks must pass.
7. A day later, delete the old folder. Keep private integration files until their owning repository retires them.

On Unix, persist an absolute `CPA_APP_DIR` override in the user-owned mode-0600 path environment file. Run this in the owner's terminal, replacing the example path:

```sh
(
  set -e
  umask 077
  mkdir -p "$HOME/.config/agent-env"
  printf '%s\n' "$HOME/.cpa/easycliproxyapi" > "$HOME/.config/agent-env/cpa-app-dir"
  chmod 600 "$HOME/.config/agent-env/cpa-app-dir"
)
```

The file contains one raw absolute path, with no shell syntax. Preflight, verify, the runbook's init/status/apply blocks, and the deployed Unix environment hook load it only when `CPA_APP_DIR` is unset or empty. A process override takes precedence. Windows uses the User environment value under the same rule. The default remains the existing Downloads installation until the owner moves it; preflight WARNs when the effective install path is in Downloads.

How the GUI's `run-on-startup` registers itself, and whether a GUI update keeps its folder, are [UNVERIFIED]. Replacing the GUI with upstream CLIProxyAPI, pinned in `versions.toml` and run as a user-level task, is an open owner decision.

## Clean up the old wiring

If the owner supplies a local untracked `.tools/legacy-cpa-paths.list`, preflight counts existing files from that inventory without opening them. Use one literal path relative to home per line; comments start with `#`. Without the inventory, preflight skips the scan. Delete them once that machine's harnesses use the helpers and its verify passes. They are secrets: `scripts/backup` does not copy them, and nothing should keep a copy.

Keep that inventory out of git. Preflight reports counts only.

## Rollout order

1. Install the pinned `op` CLI using AGENTS.md step 1. On a hub rebuild, the owner restores its service token with the no-echo procedure. Select service mode and client-key vault `agent-env`.
2. Apply the tailnet policy snippet and tag Beast. Check that every client still gets HTTP 401 from the serve URL when it sends no key.
3. On BEAST, apply to deploy `~/.cpa-tools` and the helpers. For every other device, create its vault and mint a separate key into it with the hub credential. The owner approves creation of its service account (read-only on its vault, read+write on `agent-repos`) once on BEAST and enters its token on that device. Rotate existing shared-vault keys as each device migrates.
4. Persist each device's token for its user, then preflight, init in service mode, backup, apply, and verify. Each machine's verify must show HTTP 200 for each harness. The runbook loads persisted tokens for each process without restarting the agent.
5. Clean up the old wiring on each machine.
6. Handle private integrations in their owning repositories.

## [UNVERIFIED]

- Whether Codex runs a `.cmd` file directly as its auth `command`, and whether Muse can take its key from a helper.
- Whether CPA accepts `X-Api-Key` and `Authorization` on the same request, which is what `apiKeyHelper` sends.
- The `node:os` values for Windows and Linux in posture rules. The snippet's tests that use them are commented out, because they need the Owner's login.
- The JSON shape of `op item template get "API Credential"`. `mint_client_key.py` was tested against a fake `op` with an `id: credential` field. It creates nothing when it finds no single `credential` field.
- The model-id prefixes that the verify drop-ins count per harness: `^claude`, `^(gpt|codex|o[0-9])`, `^grok` and `^muse`. A zero count is a WARN, not a FAIL.
- The GUI's key editor, its `run-on-startup` mechanism and its update behaviour.
- Repository tests do not authenticate against the real hub or 1Password. Provisioning, token persistence, and a full restore need live owner validation; the probe and mint flow are tested with fakes on Windows and in WSL.
