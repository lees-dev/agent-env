# Layout contract

Five areas build this repo. Each area owns the paths listed under it, and nothing else. To change a path another area owns, ask that area: open a separate PR, or file an issue. A file that belongs to no area belongs to **foundation**.

chezmoi reads its source state from `home/` (`.chezmoiroot`). A path under `home/` maps to a path under `~`. The repo-root directories (`scripts/`, `packages/`, `tailscale/`, `docs/`) are never deployed. Templates and scripts read them through the `repoDir` data key.

## Ownership

### foundation

| Path | What |
|---|---|
| `README.md`, `AGENTS.md`, `CLAUDE.md` | Overview; the installing agent's runbook; the import of `AGENTS.md` |
| `.gitattributes`, `.gitignore`, `.chezmoiroot`, `.gitleaks.toml`, `.secret-guard-allow` | Repo conventions and the secret scan's configuration |
| `.github/**` | CI (`secret-scan.yml`) |
| `versions.toml` | The schema and `[meta]`, `[tools.chezmoi]`, `[tools.op]`, `[ci.*]`. Other areas own their own sections (below) |
| `scripts/preflight`, `scripts/preflight.ps1` | Read-only base preflight; runs the `scripts/preflight.d/` drop-ins |
| `scripts/verify`, `scripts/verify.ps1` | Base post-apply verification; runs the `scripts/verify.d/` drop-ins |
| `scripts/backup`, `scripts/backup.ps1` | Backs up the managed targets plus the `scripts/backup.d/*.list` paths |
| `scripts/check.sh`, `scripts/secret-guard.sh`, `scripts/lib/**` | Repo checks and the shared helpers |
| `scripts/render-test.sh`, `tests/render/*.paths`, `docs/testing.md` | Renders and applies the tree into throwaway destinations in test mode (`noSecrets`), and the expected path lists |
| `home/.chezmoi.toml.tmpl` | The questions and every template data key (below) |
| `home/.chezmoiignore` | The never-managed list and the OS blocks. Other areas append only inside their own `# ---- <area>` block |
| `docs/layout.md`, `docs/research.md` | This contract. In `research.md` each area appends its own `## <area>` section |

### rules+skills

| Path | Deploys to | What |
|---|---|---|
| `home/dot_agents/skills/<name>/**` | `~/.agents/skills/<name>/` | The one canonical copy of each user skill |
| `home/dot_agents/docs/agents/*.md` | `~/.agents/docs/agents/` | `credentials.md`, `domain.md`, `issue-tracker.md`, `pr-standards.md`, `repo-defaults.md`, `subagent-routing.md`, `t3-first.md`, `triage-labels.md` |
| `home/.chezmoitemplates/rules/*` | (partials, not deployed) | Rule fragments: global rules, one fragment per `osFlavour`, the engineering-standards block |
| `home/dot_claude/CLAUDE.md.tmpl` | `~/.claude/CLAUDE.md` | Rendered from the rule partials |
| `home/dot_codex/AGENTS.md.tmpl`, `home/dot_grok/AGENTS.md.tmpl` | `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md` | Rendered from the same partials |
| (none for Muse) | | Muse has no global rules file this repo can write [UNVERIFIED path]; the owner runs `/rules import` once (`docs/skills.md`) |
| (no source entry) | `~/.claude/skills/` | Skill links only, made by the run script below; `.chezmoiignore` keeps chezmoi out of `~/.claude/skills` (see "Skill links") |
| `home/.chezmoiscripts/run_after_20-skills-links.{sh,ps1}.tmpl` | | Creates, repairs and prunes the skill links on every apply |
| `vendor-skills.lock`, `docs/skills.md` | | Vendor skill names (never copied here); where each skill came from |
| `scripts/verify.d/20-skills.{sh,ps1}` | | Link parity, LF-normalised hash parity, dangling-link scan |
| `scripts/backup.d/20-skills.list` | | The `exact_` skill directories apply may prune, and the link paths the script may replace |
| `versions.toml` `[skills.*]` | | Vendor skill packs: installed at pinned versions, never vendored |

#### lifecycle (part of rules+skills)

| Path | Deploys to | What |
|---|---|---|
| `home/dot_agents/bin/**` | `~/.agents/bin/` | Node lifecycle tools run as `node <path>` (no `executable_` prefix): the worktree engine, the credentials helper, the landing tools, and their shared `lib/*.mjs` |
| `tests/lifecycle/**` | (not deployed) | `node:test` suites with fake `gh`, `docker` and `op` |
| `docs/lifecycle.md` | | How setup, teardown, sweep and the credentials helper work |

**Skill links.** `~/.claude/skills/<name>` is a link to `~/.agents/skills/<name>`, so the two cannot drift. The link is a junction on Windows (`linkMode = "junction"`, because symlinks need Developer Mode) and a symlink elsewhere. Make the links with the run script on every OS, so all platforms take the same path. The script never touches `~/.claude/skills/synced/`, and never replaces a real directory without backing it up first.

### harness

| Path | Deploys to | What |
|---|---|---|
| `home/dot_claude/modify_settings.json` | `~/.claude/settings.json` | Merges the managed keys: model, hooks, statusLine, plugins, env |
| `home/dot_codex/modify_config.toml` | `~/.codex/config.toml` | Merges the provider, model, effort and `[mcp_servers]` (`codex mcp add` starts a blocking OAuth flow, so it is not used); removes the legacy `cpa-gui` provider |
| `home/dot_grok/modify_config.toml` | `~/.grok/config.toml` | Merges the endpoint, auth helper and model |
| `home/dot_config/muse/modify_settings.json` | `~/.config/muse/settings.json` | Merges the endpoint transport and model catalogue |
| `home/dot_t3/userdata/{modify_,create_}*.json` | `~/.t3/userdata/` | T3 settings; desktop machines only (ignored when `headless`) |
| `home/dot_config/ohmyposh/**`, other harness-adjacent dotfiles | | The status line and similar |
| `home/.chezmoitemplates/harness/*` | (partials, not deployed) | `config.toml`: every managed value, with `[machines.<remark>]` overrides; `cpa-token-path`: the one place the token helper's path is written |
| `home/.chezmoiscripts/run_onchange_after_3N-harness-*.{sh,ps1}.tmpl` | | `31` `claude mcp add`, `32` Claude plugins, `33` Muse auth from the token helper. PATH is the packages area's job |
| `scripts/backup.d/30-harness.list` | | Files those scripts change, such as `~/.claude.json` |
| `scripts/preflight.d/30-harness.*`, `scripts/verify.d/30-harness.*` (with `30-harness.checks.tmpl`) | | Harness checks |
| `versions.toml` `[harness.*]` | | Harness pins. Foundation seeded these on 2026-11-04; harness maintains them |

The harness area configures each harness. The packages area installs its binary.

### packages

| Path | What |
|---|---|
| `packages/winget.txt`, `packages/Brewfile`, `packages/apt.txt`, `packages/dnf.txt`, `packages/mise-tools.toml`, `packages/npm-global.txt` | Package lists per manager. Versions come from `versions.toml`. Not `mise.toml`: mise would load that name as a project config |
| `home/.chezmoitemplates/packages/**` | Partials: `pins.json` (pins plus overrides for this machine), `lib.sh`, `lib.ps1` |
| `home/dot_config/agent-env/env.sh`, `home/dot_config/agent-env/env.d/10-packages.sh.tmpl`, `home/dot_config/agent-env/gitbash-bin/**` | The shell environment every rc file sources, its PATH drop-in, and the Git Bash `muse` forwarder (Windows only) |
| `home/dot_config/mise/**` | mise pins in `~/.config/mise/conf.d/agent-env.toml` (not on Windows); the owner's own `config.toml` is never touched |
| `docs/packages.md`, `scripts/backup.d/10-packages.list` | How installs work per OS; files the scripts change |
| `home/.chezmoiscripts/run_onchange_before_1N-packages-*.{sh,ps1}.tmpl` | Installs and upgrades the harness binaries and tools to their pins |
| `scripts/preflight.d/10-packages.*`, `scripts/verify.d/10-packages.*` | Package checks |
| `versions.toml` `[tools.*]`, except `chezmoi` and `op` | Tool pins |

On the `server` role, install user-level only: mise, npm with a user prefix, and `~/.local/bin`. Never use `dnf`, `apt` or `sudo` there. On clients, a system package manager needs the owner's OK in step 0. chezmoi and the 1Password CLI are prerequisites that the runbook installs (steps 1 and 2). The packages area may keep them current afterwards.

### cpa

| Path | Deploys to | What |
|---|---|---|
| `home/.chezmoitemplates/secrets/cpa-client-key` | (partial) | `onepasswordRead "op://{{ .opVault }}/{{ .opCpaItem }}/credential"`, the only place the client key is read (a placeholder when `noSecrets`). Not named `cpa-key`: `.gitignore` and the guard reject that name |
| `home/dot_config/agent-env/private_cpa-key.tmpl` | `~/.config/agent-env/cpa-key` (0600) | The machine's key, written at apply time |
| `home/dot_config/agent-env/env.d/private_40-cpa-op.sh.tmpl` | `~/.config/agent-env/env.d/40-cpa-op.sh` (0600) | Unix: loads the owner's unmanaged mode-0600 `~/.config/op/agent-env-token` through `env.sh` in service mode; also loads the optional mode-0600 `~/.config/agent-env/cpa-app-dir` path environment file in either mode |
| `home/dot_config/agent-env/executable_cpa-token`, `home/dot_config/agent-env/cpa-token.cmd` | `~/.config/agent-env/` | The token helpers the harness configs point at (`.cmd` on Windows only). They print the key file, so no harness config holds the key |
| `home/dot_cpa-tools/**` | `~/.cpa-tools/` | Hub only: three client-key tools and install-path config; private tools are unmanaged (ignored unless `role = "hub"`) |
| `home/.chezmoiscripts/run_onchange_after_4N-cpa-*.{sh,ps1}.tmpl` | | Hub scheduled tasks, all user-level |
| `tailscale/**` | (not deployed) | Tailnet policy snippet (grants, tags) and the `tailscale serve` definition |
| `docs/cpa.md` | | Topology and minting a key for each machine |
| `scripts/preflight.d/40-cpa.*`, `scripts/verify.d/40-cpa.*`, `scripts/backup.d/40-cpa.list` | | Hub and client checks (authenticated probe: status code only) |
| `versions.toml` `[hub.*]`, `[tools.tailscale]` | | CLIProxyAPI and Tailscale pins |

The harness modify scripts take the base URLs from data keys (`cpaAnthropicBaseUrl`, `cpaOpenAIBaseUrl`) and the key from a cpa-owned helper path. They never take the key value itself.

## Naming conventions

### Run scripts

```
home/.chezmoiscripts/run_[<onchange|once>_]<before|after>_<NN>-<area>-<what>.<sh|ps1>.tmpl
```

A plain `run_` script runs on every apply. Use it only for a cheap, idempotent repair step (today: `run_after_20-skills-links`).

- Keep the directory flat. chezmoi orders scripts by target name, and subdirectories would break the `NN` order.
- `NN` bands: `00-09` foundation, `10-19` packages, `20-29` rules+skills, `30-39` harness, `40-49` cpa, `90-99` reserved.
- Write a `.sh.tmpl` / `.ps1.tmpl` pair when both OS families need the step. `.chezmoiignore` drops the other family's file. The script must also open with a guard, so it renders to whitespace (and chezmoi skips it) when its role, OS or harness does not apply:
  ```
  {{- if and (eq .osFlavour "windows") (has "claude" .harnesses) -}}
  ...
  {{- end }}
  ```
- Prefer `run_onchange_`. Embed a hash of every input, so an edit re-runs the script:
  `# inputs: {{ include (joinPath .repoDir "versions.toml") | sha256sum }}`
- Every script is idempotent. It exits non-zero on failure and prints counts and names only. If it changes a file that chezmoi does not manage, it lists that file in `scripts/backup.d/<NN>-<area>.list` (one path per line, relative to `~`; `#` starts a comment).
- `.sh`: `#!/bin/sh`, POSIX only, `set -eu`. `.ps1`: Windows PowerShell 5.1, ASCII only, `$ErrorActionPreference = 'Stop'`. chezmoi runs `.ps1` with `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, set in the config template.

### Harness-owned files

- Merge with `modify_<name>` (attribute order: `modify_`, then `private_`, then `dot_`). Use the modify-template form:
  ```
  {{- /* chezmoi:modify-template */ -}}
  {{ fromJson .chezmoi.stdin | setValueAtPath "a.b" "v" | toPrettyJson }}
  ```
  Use `fromToml` / `toToml` for TOML; they drop comments, so pass the file through byte for byte when every managed value is already right. Set only the keys you manage and never delete unknown keys. The one exception is a key that holds a plaintext credential the managed wiring replaces (Claude `env.ANTHROPIC_AUTH_TOKEN`, the Codex `cpa-gui` provider). When the file does not exist yet, `.chezmoi.stdin` is empty, so start from `{}`.
- Use `create_<name>` for files that are seeded once and then left to the harness.
- Add MCP servers in run scripts through the harness CLI (`claude mcp add --scope user ...`), never by writing the harness's state file. Codex is the exception: its servers live in `config.toml`, which the `modify_` template merges, because `codex mcp add` starts a blocking OAuth flow.

### Secrets

- Only the partials in `home/.chezmoitemplates/secrets/` may call the `onepassword*` template functions.
- A source file that includes one (`{{ template "secrets/<name>" . }}`) must have `private_` in its name, or be a `run_` script.
- 1Password items: `cpa-client-<machine>` (field `credential`) for the CPA key. Name other items `<area>-<purpose>[-<machine>]`. Apply reads client keys from `{{ .opVault }}`: `agent-env` for the hub and opt-in account mode, `agent-env-<machine>` for other service-mode devices. Device service accounts may read only their own vault (docs/cpa.md "1Password vaults"). The owner-only admin vault holds no apply-time client keys.
- `scripts/secret-guard.sh` enforces all three rules.

### Drop-ins

| Directory | File | Contract |
|---|---|---|
| `scripts/preflight.d/` | `<NN>-<area>.sh` / `.ps1` | Read-only. Sourced or dot-sourced in name order. Uses `ae_ok`/`ae_warn`/`ae_fail`/`ae_hint` (`Ae-Ok`... in PowerShell). Never calls `exit`. Variables: `REPO VERSIONS ROLE MACHINE OS VAULT CPA_URL` (`$Repo $Versions $Role $Machine $Vault $CpaUrl`) |
| `scripts/verify.d/` | `<NN>-<area>.sh` / `.ps1` | Read-only, same helpers. Variables: `REPO VERSIONS ROLE MACHINE OS HARNESSES` (`$Repo $Versions $Role $Machine $Harnesses`) |
| `scripts/backup.d/` | `<NN>-<area>.list` | Paths relative to `~` that run scripts change outside chezmoi |

A `.sh` drop-in starts with `# shellcheck shell=sh`, so `scripts/check.sh` parses it.

### versions.toml

Use one `[<area>.<name>]` section per item, with flat `key = "value"` lines: `version` (the pin), `source` (the registry or release URL, or `observed`), and optional extras. `[overrides.<machine>]` holds per-machine pins, keyed by tool name. Shell scripts read the file with `ae_toml_get` / `ae_pin`, and templates with `include ... | fromToml`.

## Template data keys

Set in `home/.chezmoi.toml.tmpl`. The answers come from an `AGENT_ENV_*` environment variable, then the existing config, then a prompt.

| Key | Type | Values / source |
|---|---|---|
| `role` | string | `hub` \| `client` \| `server` (env `AGENT_ENV_ROLE`) |
| `machine` | string | Machine remark, `^[a-z0-9][a-z0-9-]{0,62}$`; the default is `<hostname>-wsl` on WSL and the hostname elsewhere (env `AGENT_ENV_MACHINE`) |
| `cpaUrl` | string | Hub base URL without `/v1`; the default is `https://beast-1.tail7f661e.ts.net` (env `AGENT_ENV_CPA_URL`); must be `https://`, except `http://127.0.0.1:<port>` or `http://localhost:<port>` when `osFlavour` is `wsl` (WSL on the hub host) |
| `opVault` | string | Client-key vault; defaults to `agent-env` for hub or account mode, `agent-env-<machine>` for other service-mode devices; owner-only vaults are never used (env `AGENT_ENV_OP_VAULT`) |
| `opMode` | string | `account` \| `service`; defaults to `service` on every device; account mode is opt-in (env `AGENT_ENV_OP_MODE`) |
| `harnesses` | list | Any of `claude codex grok muse`; the default is all four (env `AGENT_ENV_HARNESSES`, comma-separated) |
| `noSecrets` | bool | Test mode, env `AGENT_ENV_NO_SECRETS=1` only (never asked, never remembered). Secret partials return a placeholder and op is never called; every command fails when the destination is the real home (`docs/testing.md`) |
| `osFlavour` | string | `windows` \| `wsl` \| `linux` \| `macos` (derived: `.chezmoi.os`, and WSL from `.chezmoi.kernel.osrelease`) |
| `distro` | string | `windows`, `macos` or the os-release `id` (`ubuntu`, `rocky`, ...) |
| `distroFamily` | string | `debian` \| `rhel` \| `windows` \| `macos` \| the raw id |
| `pkgManager` | string | `winget` \| `brew` \| `apt` \| `dnf` \| `none` |
| `headless` | bool | `true` for the `server` role and for `wsl`; desktop-only targets (T3) are skipped when it is true |
| `linkMode` | string | `junction` on Windows, `symlink` elsewhere |
| `cpaAnthropicBaseUrl` | string | `cpaUrl`, for Claude-style clients |
| `cpaOpenAIBaseUrl` | string | `cpaUrl + "/v1"`, for OpenAI-style clients |
| `opCpaItem` | string | `cpa-client-<machine>` |
| `repoDir` | string | Absolute path of this checkout (the source dir minus `/home`) |
| `backupRoot` | string | `~/.agent-env-backups` |

Run scripts also get these environment variables (`scriptEnv`): `AGENT_ENV_REPO`, `AGENT_ENV_ROLE`, `AGENT_ENV_OS`, `AGENT_ENV_MACHINE`, `AGENT_ENV_HARNESSES`, `AGENT_ENV_BACKUP_ROOT`, `AGENT_ENV_NO_SECRETS` (`1` or `0`). The packages scripts also read `AGENT_ENV_SYSTEM_PACKAGES` from the apply's own environment (`docs/packages.md`).

When the config template changes, update this table as needed and re-run `chezmoi init --source <checkout>` on each machine before applying. Use the existing machine answers and persisted-environment loaders from AGENTS.md step 3. The `Once` prompts keep the existing answers. This includes derived-key changes: existing Linux client/hub configs keep the old `headless = true` until init renders the new value. Follow AGENTS.md "Updating a machine later".

## Packages-only bootstrap

`scripts/install-tools` and `scripts/install-tools.ps1` belong to packages. They copy only the files listed in `packages/tools-stage.txt` into an isolated source under `.tools/`, with their own `scripts/tools-config.toml.tmpl` and `scripts/tools-ignore.tmpl`. That config supplies the package scripts' existing data keys and reads no credentials. `AGENT_ENV_TOOLS_REPO` supplies the original checkout path only inside the stage. It is not a normal template data key or a persistent setting. The stage never copies the main config, secret partials, harness configuration, or the rest of the source tree. Shared entry points and changes to `headless` are included in this owner-authorized tools-stage task.
