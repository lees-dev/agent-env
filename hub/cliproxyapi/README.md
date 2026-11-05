# CLIProxyAPI hub configuration

> **Hub only (`role hub`).** Use these files only to set up or restore the CLIProxyAPI hub. A normal setup never installs the proxy and must not use these files. Clients use the hub on BEAST at `https://beast-1.tail7f661e.ts.net`.

These are scrubbed configuration copies, not live credentials. Replace placeholders only in the installed copies, outside this repository.

| Repository file | Destination relative to the EasyCLIProxyAPI install directory |
|---|---|
| `config.yaml` | `cpa-core/config.yaml` (core configuration) |
| `easycliproxyapi-config.toml` | `config.toml` (GUI configuration) |
| `mcp-servers.json` | `mcp-servers.json` (GUI MCP server definitions) |

## Settings to preserve

The core settings below record the choices that differ from the stock `config.example.yaml`, plus the listener port to preserve during restoration.

| Core setting | Value |
|---|---|
| `server.host` | `127.0.0.1` |
| `server.port` | `8317` |
| `access.api-keys` | One client key per machine |
| `management.secret-key` | Restore the management-key item from the owner-only admin vault, or generate a new key |
| `oauth.auth-dir` | `../oauth` |
| `observability.usage.usage-statistics-enabled` | `true` |
| `plugins.enabled` | `true` |
| `requests.streaming.bootstrap-retries` | `1` |
| `routing.strategy` | `fill-first` |
| `routing.session-affinity` | `true` |
| `routing.session-affinity-rebind-on` | `quota` (preserve the configured rebind trigger) |
| `routing.session-affinity-ttl` | `""` |
| `routing.cooldown.save-cooldown-status` | `true` |

Preserve these GUI settings too:

| GUI setting | Value |
|---|---|
| `allow-lan` | `false` |
| `run-on-startup` | `true` |
| `start-core-on-launch` | `true` |
| `request-retry` | `3` |
| `max-retry-credentials` | `0` |
| `max-retry-interval` | `30` |
| `disable-cooling` | `false` |

There are no model aliases, payload rules, or excluded models.

## Restore after a format

The owner restores the OAuth backup Document and management-key item from their owner-only admin vault, using their account session in their own terminal. Remove `OP_SERVICE_ACCOUNT_TOKEN` from that process first. Other devices' service accounts never receive this vault. Use the restore item names from the private owner inventory; no other admin items are needed.

With that owner account session, create a new restore directory accessible only to the current Windows user, then download directly to files. Replace the vault and restore item placeholders with the owner's item names. Stop on any error and check each `op` exit status before continuing:

```powershell
$ErrorActionPreference = 'Stop'
$restore = Join-Path $HOME '.cpa-restore'
$null = New-Item -ItemType Directory -Path $restore
$acl = Get-Acl -LiteralPath $restore
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -LiteralPath $restore -AclObject $acl
$null | op document get '<oauth-backup-item>' --vault '<owner-admin-vault>' --out-file (Join-Path $restore 'oauth.zip') *> $null
if ($LASTEXITCODE -ne 0) { throw 'OAuth backup restore failed' }
$null | op read 'op://<owner-admin-vault>/<management-key-item>/credential' --out-file (Join-Path $restore 'management-secret') *> $null
if ($LASTEXITCODE -ne 0) { throw 'Management key restore failed' }
```

These commands never send values to stdout. With the GUI stopped, extract the zip into the installed `oauth/` directory and load the management key from the restricted file into both installed configs without displaying it. Keep the restored files out of this repo and synced folders. Follow the procedure below, then remove the temporary restore directory after successful verification.

## Restore the hub after a format

1. Confirm that the owner explicitly selected `hub` for this device. Read the [runbook](../../AGENTS.md) and [hub procedures](../../docs/cpa.md) before changing the installed hub.
2. Install pinned [EasyCLIProxyAPI 0.3.73](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.73) from [router-for-me/EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI). Use a stable path such as `~/.cpa/easycliproxyapi`, outside Downloads and synced folders. Core versions 8.0.53 and 8.0.54 are the restore baseline; `versions.toml` records 8.0.54 observed on BEAST. Confirm the installed core version in the GUI. Persist the chosen absolute path with `[Environment]::SetEnvironmentVariable('CPA_APP_DIR', '<absolute install path>', 'User')`. Preflight and verify load this User value when the process value is empty. The runbook's init/status/apply blocks inline the same read. Unix uses the persisted path environment file in docs/cpa.md. Apply renders this path into `~/.cpa-tools/cpa-tools.toml` for the scheduled task, so no public tracked file changes.
3. With the GUI stopped, copy the three files to the destinations above. Restore the OAuth backup and management key using "Restore after a format" above. Replace `<MANAGEMENT_KEY>` in both installed configuration files with the recovered value. If no backup is usable, generate a new management key locally and later sign upstream accounts in again. Keep values out of command arguments, logs, chat, and this repo.
4. Use service mode with the hub service token persisted by the owner using the no-echo procedure and client-key vault `agent-env`. Restore only this hub's own `cpa-client-<hub remark>` from that vault, or provision a temporary hub key if none exists. Replace the client-key placeholders in both installed configurations with that key, keeping one matching entry in each file. Remove extra placeholder entries. This bootstrap key lets the hub's first preflight and apply succeed before its key tools are deployed. Keep both client-key lists nonempty. In the installed core YAML, use single quotes around the seed key: `    - '<hub client key>'`. The existing `add_client_key.py` requires that format. Start the GUI and confirm the restored upstream sessions work. OAuth files are never in this repo.
5. Sign the hub into Tailscale and recreate the serve mount from a normal terminal. The runbook's preflight needs this route before its first apply:

   ```powershell
   tailscale serve --bg --https=443 --set-path=/v1 http://127.0.0.1:8317/v1
   ```

6. Follow the runbook with `role hub`, including its backup and approval steps, to deploy `~/.cpa-tools/`. Before minting, stop the GUI and confirm that the installed core key list still uses single quotes. Mint each other device's key with `mint_client_key.py <remark> --vault agent-env-<remark>`. Use the hub credential for client-key administration. Creating each read-only device service account needs the owner's one-time approval on the hub. Persist its token on that device using the runbook so later agent work never prompts. Never grant it owner-only vaults or copy another machine's key. For an existing 1Password item, follow [Rotate or revoke a key](../../docs/cpa.md#rotate-or-revoke-a-key) first. If a temporary hub key was used, rotate it with the same procedure and mint tool, using `--vault agent-env`. Restart the GUI to reload keys and apply on each machine to deploy its new key. Account mode remains an opt-in.
7. Restore the optional `~/.cpa-tools/soonest_reset.py` from the owner's private backup before apply if its scheduled task is needed. This public repo does not distribute upstream-account tools. Without the script, apply leaves the task alone and preflight/verify WARN; restore it and rerun the rendered task script to register it later.
8. Run preflight and verify from the runbook. Confirm loopback binding, the `/v1` serve mount, no Funnel, matching GUI/core key lists, and authenticated harness probes. Print counts and HTTP statuses only. Check the GUI and core versions against `versions.toml`.

The GUI pin and source already live in `versions.toml` `[hub.easycliproxyapi]`. [Research sources](../../docs/research.md#hub-restore-2026-11-05) record the releases used here. A restore and upstream account sign-ins are [UNVERIFIED] by the repository tests.
