# Research: versions, sources, verification

Rule: resolve each version from its registry or release page on the day you pin it, cite the primary docs for every API, config key and flag the repo uses, and mark what was not tested `[UNVERIFIED]`. Each area appends its own `## <area>` section.

## Hub restore (2026-11-05)

- EasyCLIProxyAPI [v0.3.73](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.73): release and Windows amd64 asset confirmed with the GitHub releases API. The existing `[hub.easycliproxyapi]` pin and source are retained.
- CLIProxyAPI [v8.0.53](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.53) and [v8.0.54](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.54): both releases confirmed with the GitHub API. The existing core pin records 8.0.54 observed on BEAST. Confirm the bundled or updated core in the GUI during restore.
- Core configuration reference: [config.example.yaml at v8.0.54](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.54/config.example.yaml). The three owner-supplied scrubbed files in `hub/cliproxyapi/` are preserved unchanged. They record loopback binding, per-machine keys, relative OAuth storage, usage statistics, plugins, streaming retry, and routing choices.
- Serve restoration flags: [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve). Only `/v1` is mounted.
- [UNVERIFIED] Full format recovery, GUI startup registration, and upstream OAuth sign-ins. No installed hub, OAuth directory, or Tailscale state was changed.

## foundation (2026-11-04)

### Versions resolved today

| Item | Pin | Source (queried 2026-11-04) |
|---|---|---|
| chezmoi | 2.74.0 (released 2026-11-01) | https://github.com/twpayne/chezmoi/releases/tag/v2.74.0 ; winget `twpayne.chezmoi` lists 2.74.0 |
| 1Password CLI `op` | 2.41.1 (2.42–2.44 are betas) | https://app-updates.agilebits.com/product_history/CLI2 ; winget `AgileBits.1Password.CLI` lists 2.41.1 |
| Tailscale | 1.104.5 | https://github.com/tailscale/tailscale/releases/tag/v1.104.5 ; winget `tailscale.tailscale` lists 1.104.5 |
| Claude Code | 2.1.318 | `npm view @anthropic-ai/claude-code version` |
| Codex CLI | 0.166.0 | `npm view @openai/codex version` |
| Grok CLI | 1.0.70 | `grok --version` on Beast. No public registry found [UNVERIFIED] |
| Muse Code | 1.4.14 | `muse --version` on Beast. No public registry found [UNVERIFIED] |
| git | 2.56.0 / Git for Windows 2.56.0.windows.4 | https://github.com/git/git/tags ; https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4 |
| gh | 2.103.3 | https://github.com/cli/cli/releases/tag/v2.103.3 |
| Node | 24.22.2 (LTS Krypton; 26.13.0 Lithium is also LTS) | https://nodejs.org/dist/index.json |
| uv | 0.13.7 (server override 0.12.3) | https://github.com/astral-sh/uv/releases/tag/0.13.7 |
| mise | 2026.11.0 | https://github.com/jdx/mise/releases/tag/v2026.11.0 |
| PowerShell 7 | 7.6.9 (optional) | https://github.com/PowerShell/PowerShell/releases/tag/v7.6.9 |
| winget | 1.29.380 | https://github.com/microsoft/winget-cli/releases/tag/v1.29.380 |
| CLIProxyAPI | 8.0.54 | https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.54 |
| gitleaks | 8.30.1; linux_x64 sha256 `551f6fc8…f2470eb` | https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1 (checksums file) |
| actions/checkout | v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1` | https://github.com/actions/checkout/releases/tag/v7.0.1 |
| gitleaks-action | v3.0.0 (not used, see below) | https://github.com/gitleaks/gitleaks-action/releases/tag/v3.0.0 |

### Primary docs used

chezmoi (docs at tag v2.74.0, https://github.com/twpayne/chezmoi/tree/v2.74.0/assets/chezmoi.io/docs):
- `.chezmoiroot`: https://www.chezmoi.io/reference/special-files/chezmoiroot/ . The config template must sit inside the root, so it is `home/.chezmoi.toml.tmpl`.
- Config template and `promptChoiceOnce` / `promptStringOnce` / `promptMultichoiceOnce`: https://www.chezmoi.io/reference/templates/init-functions/
- `--promptString` and similar flags key on the prompt text, not the data key. Tested: `execute-template --init --promptString machine=x` did not set `machine`. So the template reads `AGENT_ENV_*` variables first. https://www.chezmoi.io/reference/commands/execute-template/
- Template variables (`.chezmoi.kernel`, `.chezmoi.osRelease`, `.chezmoi.sourceDir`, `.chezmoi.workingTree`, `.chezmoi.homeDir`): https://www.chezmoi.io/reference/templates/variables/
- WSL detection through `.chezmoi.kernel.osrelease`: https://www.chezmoi.io/user-guide/machines/windows/
- Source-state attributes (`create_`, `modify_`, `private_`, `run_onchange_`, prefix order): https://www.chezmoi.io/reference/source-state-attributes/
- `modify_` templates (`chezmoi:modify-template`, `.chezmoi.stdin`, `setValueAtPath`): https://www.chezmoi.io/user-guide/manage-different-types-of-file/
- `.chezmoiignore` is always a template: https://www.chezmoi.io/reference/special-files/chezmoiignore/
- 1Password modes (`onepassword.mode = account|service|connect`; `account` refuses to run when `OP_SERVICE_ACCOUNT_TOKEN` is set): https://www.chezmoi.io/user-guide/password-managers/1password/
- `onepasswordRead`: https://www.chezmoi.io/reference/templates/1password-functions/onepasswordRead/
- `onepassword.prompt`, `scriptEnv`, `sourceDir`: https://www.chezmoi.io/reference/configuration-file/variables/
- Script interpreters (the default `.ps1` interpreter is `pwsh`, so the config sets `powershell`): https://www.chezmoi.io/reference/configuration-file/interpreters/
- `chezmoi managed --include --path-style absolute`, `chezmoi verify --exclude`: https://www.chezmoi.io/reference/commands/managed/ , https://www.chezmoi.io/reference/commands/verify/
- Install with a pinned tag (`get.chezmoi.io -b DIR -t vX.Y.Z`, verifies checksums): https://www.chezmoi.io/install/ , https://github.com/twpayne/chezmoi/blob/v2.74.0/assets/scripts/install.sh

1Password CLI:
- Getting started, desktop app integration: https://developer.1password.com/docs/cli/get-started/ , https://developer.1password.com/docs/cli/app-integration/
- Service accounts with `OP_SERVICE_ACCOUNT_TOKEN`: https://developer.1password.com/docs/service-accounts/use-with-1password-cli/
- `op whoami`, `op vault get`, `op item list`: https://developer.1password.com/docs/cli/reference/commands/whoami/ , https://developer.1password.com/docs/cli/reference/management-commands/vault/ , https://developer.1password.com/docs/cli/reference/management-commands/item/
- Secret references `op://vault/item/field`: https://developer.1password.com/docs/cli/secret-reference-syntax/

Tailscale: `tailscale status --json`: https://tailscale.com/kb/1080/cli#status ; `tailscale serve`: https://tailscale.com/kb/1242/tailscale-serve ; grants: https://tailscale.com/kb/1324/grants

gitleaks: the `gitleaks git` and `gitleaks dir` subcommands, `--redact`, `--no-banner`, `--exit-code`, and the `[extend] useDefault` config: https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md

gitleaks-action: v3 needs `GITLEAKS_LICENSE` for repos owned by an Organization (https://github.com/gitleaks/gitleaks-action/blob/v3.0.0/README.md). `gh api users/lees-dev` reports `"type": "Organization"`. So CI runs the same gitleaks release binary and verifies its sha256 instead of using the action. If a license secret is ever added, the action is a one-step swap.

Git: `.gitattributes` `text eol=`: https://git-scm.com/docs/gitattributes ; `git ls-files --eol`: https://git-scm.com/docs/git-ls-files ; `git grep` with `:(exclude)` pathspecs: https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-aiddefpathspecapathspec

Windows: `robocopy /XJ`: https://learn.microsoft.com/windows-server/administration/windows-commands/robocopy ; the PowerShell parser API: https://learn.microsoft.com/dotnet/api/system.management.automation.language.parser.parsefile ; `winget install --version --exact`: https://learn.microsoft.com/windows/package-manager/winget/install

### Tested today

Everything below was tested with chezmoi 2.74.0 binaries in `.tools/` (checksum-verified), fake home directories, and a copy of the repo:
- `home/.chezmoi.toml.tmpl` renders on Windows (`osFlavour=windows`, `linkMode=junction`, `pkgManager=winget`) and on WSL Ubuntu (`wsl`, `debian`, `apt`, `headless=true`). A bad role, a bad machine remark, a non-https `cpaUrl` and an unknown harness each fail with a clear message.
- `.chezmoiignore` drops `.chezmoiscripts/*.ps1` on Linux and `*.sh` on Windows, `AppData/**` off Windows, and `.claude.json` everywhere.
- `include (joinPath .repoDir "versions.toml") | fromToml` works from templates.
- `.chezmoi.workingTree` is the enclosing git repo, which can be a parent directory, so `repoDir` and `sourceDir` come from `.chezmoi.sourceDir` with `/home` removed.
- `scripts/preflight.ps1` runs on Windows PowerShell 5.1 on Beast: 19 ok, 1 warn (grok is not on PATH), 1 fail (`op` is not installed). `scripts/preflight` runs under `dash` on WSL and exits 1 on a FAIL.
- `scripts/backup` and `scripts/backup.ps1`: dry run and real run, files copied with sha256, symlinks and junctions recorded rather than followed, missing paths counted, refusal when the backup root is inside the repo. `scripts/verify(.ps1)`: initialised config, source path, `chezmoi verify`, harness pins and the latest backup.
- `scripts/secret-guard.sh` was tested against planted fakes in a throwaway clone. It flags an `sk-` key, a PEM header, a `tskey-` key, a non-allowlisted email in content and in a path, `auth.json`, an `oauth/` dir, a CRLF blob in the index, `onepasswordRead` outside `secrets/`, and a secrets include in a non-private target. Allowlisted addresses pass.
- gitleaks 8.30.1 with `.gitleaks.toml`: no findings in the repo, and the custom CPA-key rule fires on a planted fake.
- Windows PowerShell 5.1 strips embedded `"` from native-program arguments (`'{{ index . "role" }}'` reached chezmoi as `{{ index . role }}`), so the helpers use quote-free templates.

### Findings for other areas

- **WSL on Beast cannot reach the serve URL.** `beast-1.tail7f661e.ts.net` refuses TCP 443 inside WSL. From Windows the same probe returns HTTP 401. A WSL instance on the hub host therefore needs another route, such as `127.0.0.1:8317` through mirrored networking, or Tailscale inside WSL. That decision belongs to the cpa area.
- WSL drift confirmed by `scripts/verify`: claude 2.1.301 (pin 2.1.318), codex 0.162.1 (pin 0.166.0), grok 1.0.60 not on PATH, muse and uv missing.
- On `/mnt/c` (DrvFs), `chmod 700` on the backup root has no effect, so mode 777 shows. Real Linux homes are unaffected.

### [UNVERIFIED]

- `op whoami` with the desktop-app integration may raise an authorization prompt, or exit non-zero until one is approved. Preflight treats non-zero as "not signed in", which is the safe side. `op` is not installed on Beast, so this is untested.
- The `"title": "<name>"` shape of `op item list --format json` output. The match tolerates any whitespace.
- macOS and Rocky have not been run. Only Windows (PowerShell 5.1) and WSL Ubuntu (`dash`) have.
- The CI workflow has not run on GitHub, because the repo is not pushed.
- The Grok and Muse install sources and registries, and the path where Muse reads global rules.
- Whether `chezmoi verify --exclude=scripts` reports `modify_` targets as clean once they are merged. It needs a real modify script to test (harness area).

## rules+skills (2026-11-04)

### Versions resolved today

| Item | Pin | Source (queried 2026-11-04) |
|---|---|---|
| mattpocock-skills | 1.3.2 = `d1478fcb140db0b93c0c8df17bcfd311844749d0` (released 2026-10-29) | `gh api repos/mattpocock/skills/releases/latest`; https://github.com/mattpocock/skills/releases/tag/v1.3.2 |
| higgsfield skills | 0.14.0 at `4d0757471a704dac8729ea3c2ef0f3f330e0d9b6` (no tags; `VERSION` file) | https://github.com/higgsfield-ai/skills/blob/4d0757471a704dac8729ea3c2ef0f3f330e0d9b6/VERSION |
| Higgsfield CLI | `@higgsfield/cli` 1.2.2 | `npm view @higgsfield/cli version`; matches `higgsfield --version` on Beast |
| typesafe skills | 0.6.2 = `302eea662c54bca6730873fe245bec1d69ebc23d` (WSL runs 0.5.7) | `gh api repos/typesafe-ai/skills/tags`; `.claude-plugin/plugin.json` at v0.6.2 |
| skills CLI (`npx skills`) | 1.7.6 | `npm view skills version` (not pinned: used only in the vendor install hints) |
| Grok | 1.0.70 (observed) | `~/.grok/version.json`; local docs under `~/.grok/docs/user-guide/` |
| Muse Code | 1.4.14 (observed) | `muse --version`; `muse skills --help` |

### Primary docs used

- chezmoi `includeTemplate` (dynamic partial names; `template` takes only a literal name): https://www.chezmoi.io/reference/templates/functions/includeTemplate/
- chezmoi `glob` and `joinPath`: https://www.chezmoi.io/reference/templates/functions/glob/ , https://www.chezmoi.io/reference/templates/functions/joinPath/
- `.chezmoi.destDir` (the scripts write under the destination, so a `--destination` test never touches the real home): https://www.chezmoi.io/reference/templates/variables/
- `exact_`, `executable_`, `literal_` and `run_after_`: https://www.chezmoi.io/reference/source-state-attributes/ , https://www.chezmoi.io/reference/target-types/#scripts
- `.chezmoitemplates`: https://www.chezmoi.io/reference/special-directories/chezmoitemplates/
- sprig `merge` (the first dict wins; used to add `.harness`): https://masterminds.github.io/sprig/dicts.html
- Codex skills: user scope `$HOME/.agents/skills`, and it follows symlinked skill folders: https://learn.chatgpt.com/docs/build-skills (which `developers.openai.com/codex/skills` redirects to)
- Codex global rules: `~/.codex/AGENTS.md`, or `CODEX_HOME`, with `AGENTS.override.md` first: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Claude Code: the changelog fixed "skill files inside symlinked skill directories", so symlinked skill dirs are supported: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Grok (docs that ship with 1.0.70, `~/.grok/docs/user-guide/`): `08-skills.md` (skill roots, including `.agents/skills` at each tier and `~/.claude/skills`), `12-project-rules.md` (rules files, and `~/.claude/` scanned for `CLAUDE.md`), and `05-configuration.md` ("Harness compatibility": `[compat.claude] agents`). `01-getting-started.md` names `~/.grok/AGENTS.md` as the global rules.
- Muse: `muse skills --help` (user skills in `~/.agents/skills`, plus `muse skills import --from claude|codex`). The `/rules import` behaviour comes from strings in the 1.4.14 binary; Muse has no public docs that I could find.
- Windows junctions: `New-Item -ItemType Junction` https://learn.microsoft.com/powershell/module/microsoft.powershell.management/new-item ; `Directory.Delete(String, Boolean)` https://learn.microsoft.com/dotnet/api/system.io.directory.delete ; `FileSystemInfo.LinkType` and `Target` in PowerShell 5.1: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_providers
- `npx skills` (vercel-labs/skills), the installer the vendor packs document: https://github.com/vercel-labs/skills ; higgsfield `INSTALL.md` at the pinned SHA

### Tested today

These tests ran with chezmoi 2.74.0 from `.tools/`, against fake homes under `.tools/` and an isolated copy of the source:
- The rules render on Windows (`win-claude.md` keeps the live `~/.claude/CLAUDE.md` text and adds only the header, the new subsection and the new marker), on WSL (`machine-wsl`), and with data overrides for `linux`/rocky/server and `macos`.
- A full `chezmoi apply` on Windows deploys 153 managed entries and runs one script (the `.sh` file is ignored). It created 31 junctions, a second apply reported 31 ok, and `chezmoi verify --exclude=scripts` was clean.
- Edge cases on Windows. The fake home held a CRLF real copy identical to the canonical one, an older `council`, a junction to a wrong target, a junction into `~/.agents/skills/gone` that dangled, `synced/` and a vendor dir. Result: 28 created, 1 replaced (backed up), 1 relinked, 1 pruned, 1 kept (differ). `synced` and the vendor dir were untouched. The target of the relinked junction still exists. Every link has `LinkType=Junction`.
- The same cases on WSL, with chezmoi linux and `dash -n`: 29 created, 1 replaced, 1 pruned, 1 kept. The second run reported 30 ok and 1 kept.
- `scripts/verify.d/20-skills.{sh,ps1}` against the fake homes, under `dash` and Windows PowerShell 5.1: 5 ok, 1 warn (Grok reads the rules twice) and 1 fail (the kept `council`), as expected.
- The deployed tree hashes equal the source hashes for all 31 skills, and no skill name is also a vendor skill name.
- `grok inspect --json` (Beast, 1.0.70) lists `~/.grok/Agents.md` and `~/.claude/Claude.md` as global instructions, so Grok loads both today.

### Unverified

- [UNVERIFIED] Claude Code finds skills through a Windows directory junction. Symlinked skill dirs are supported, but this was not run with a real `claude` session on Beast. Check `/skills` after the first apply.
- [UNVERIFIED] The path of Muse's global rules file, and what `context.foreign_personal_rules` does. Use `/rules import` (docs/skills.md).
- [UNVERIFIED] The macOS run of `run_after_20-skills-links.sh`: no Mac was used. `readlink` without `-f`, and `shasum` instead of `sha256sum`, are the only branches that differ.
- Tested 2026-11-04 (integration, throwaway home, Grok 1.0.70): `[compat.claude] agents = false` and `rules = false` both parse (`grok inspect --json` reports the cell as `source: config`), but neither removes `~/.claude/Claude.md` from `projectInstructions`. The documented switch does not work in 1.0.70, so agent-env does not set it (docs/skills.md).

## cpa (2026-11-04)

### Versions resolved today

| Item | Pin | Source (queried 2026-11-04) |
|---|---|---|
| Tailscale | 1.104.5, still the latest (released 2026-11-03). Beast runs 1.104.4 | `gh api repos/tailscale/tailscale/releases/latest`; https://github.com/tailscale/tailscale/releases/tag/v1.104.5 |
| CLIProxyAPI core | 8.0.54 runs on Beast; 8.0.55 released 2026-11-04 18:03 UTC (recorded as `latest`) | https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.55 |
| EasyCLIProxyAPI GUI | 0.3.73 runs on Beast; 0.3.74 released 2026-11-04 18:04 UTC (recorded as `latest`). It updates itself and the core | https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.74 |
| Codex (for the auth-command schema) | rust-v0.166.0 | https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/protocol/src/config_types.rs (`ModelProviderAuthInfo`: `command`, `args`, `timeout_ms`, `refresh_interval_ms`, `cwd`) ; https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/model-provider-info/src/lib.rs (`env_key`, `experimental_bearer_token`, `auth`) |
| Python on Beast | 3.13 (`py`, `pythonw`; tomllib needs 3.11+) | `Get-Command` on Beast |

### Primary docs used

- Tailscale grants (`src`, `dst`, `ip`; grants and ACLs coexist): https://tailscale.com/kb/1324/grants ; examples (group or `autogroup:member` to a tag on `tcp:443`, `autogroup:self`, `tagOwners`): https://tailscale.com/docs/reference/examples/grants
- Policy file syntax (autogroups `member`, `admin`, `owner`, `tagged`, `self` and where each may appear; `hosts`; `tests` with `accept`/`deny`/`srcPostureAttrs`): https://tailscale.com/docs/reference/syntax/policy-file
- Device posture (`postures`, `node:os IN [...]`, `node:tsVersion`, `srcPosture`; default attributes on all plans): https://tailscale.com/docs/features/device-posture/postures-and-attributes , https://tailscale.com/kb/1288/device-posture
- Tailscale API, policy file: `GET /api/v2/tailnet/{tailnet}/acl` (JSON or HuJSON by `Accept`, returns `ETag`), `POST .../acl` with `If-Match`, `POST .../acl/validate`, bearer auth, `-` for the token's tailnet. Read from the OpenAPI document `https://api.tailscale.com/api/v2?outputOpenapiSchema=true`, rendered at https://tailscale.com/api
- `tailscale serve` (`--bg`, `--https=<port>`, `--set-path`, proxy only to `http://127.0.0.1`, `... off`, `serve reset`, `serve status --json`): https://tailscale.com/kb/1242/tailscale-serve
- 1Password CLI `op item create` with a JSON template piped on stdin (`-` argument), and the warning that command arguments are visible to other processes: https://www.1password.dev/cli/reference/management-commands/item/ (the old developer.1password.com URL redirects here); `op read`: https://developer.1password.com/docs/cli/reference/commands/read/ ; secret references: https://developer.1password.com/docs/cli/secret-reference-syntax/
- chezmoi `onepasswordRead` (in the `secrets/cpa-client-key` partial): https://www.chezmoi.io/reference/templates/1password-functions/onepasswordRead/ ; `private_`, `executable_`: https://www.chezmoi.io/reference/source-state-attributes/
- Claude Code `apiKeyHelper` (runs via `/bin/sh`, or `cmd` on Windows; output sent as `X-Api-Key` and `Authorization: Bearer`): https://code.claude.com/docs/en/settings-reference#apikeyhelper ; `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`: https://code.claude.com/docs/en/env-vars
- curl `-H @-` (header lines from stdin, so the key is not on argv), `-w '%{http_code}'`: https://curl.se/docs/manpage.html#-H
- Windows Task Scheduler cmdlets (`Register-ScheduledTask`, `New-ScheduledTaskTrigger -RepetitionInterval`, `New-ScheduledTaskSettingsSet -ExecutionTimeLimit -MultipleInstances`, `New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Limited`, `Export-ScheduledTask`, `Get-ScheduledTaskInfo`): https://learn.microsoft.com/powershell/module/scheduledtasks/ ; `HttpWebRequest` in Windows PowerShell 5.1: https://learn.microsoft.com/dotnet/api/system.net.httpwebrequest
- Python `-I` (isolated mode: the script's directory is not on `sys.path`, which is why each hub tool carries its own small `app_dir()` instead of a shared module): https://docs.python.org/3.13/using/cmdline.html#cmdoption-I ; `secrets.token_urlsafe`: https://docs.python.org/3.13/library/secrets.html#secrets.token_urlsafe ; `tomllib`: https://docs.python.org/3.13/library/tomllib.html

### Tested today (Beast, Windows PowerShell 5.1, and WSL Ubuntu `dash`)

- Live probes without a key. The serve URL returns `/v1/models` 401 and `/v8/management/config` 404, and `/`, `/v1beta`, `/api/...` also return 404. Loopback 127.0.0.1:8317 returns 401 for both. `tailscale serve status --json` shows one handler, `/v1` -> `http://127.0.0.1:8317/v1`, and `tailscale funnel status` says tailnet only. From WSL: the serve URL is refused (000) and 127.0.0.1:8317 returns 401.
- Tailnet policy tests use placeholder identities. Live device inventory is not published.
- `list_client_keys.py` was tested for GUI/core key-list parity. No live key inventory is published.
- `mint_client_key.py` and `add_client_key.py` against a fake `op` and a fake CPA folder under `.tools/`. Tested: a bad remark (exit 2), dry run, mint (item stored, read back, registered, a 63-character `sk-cpa-` key), a second mint refused because the item exists, and a duplicate remark refused. `list_client_keys.py` stayed in sync afterwards.
- `preflight.d/40-cpa.ps1` and `.sh` were exercised on Windows and WSL for hub-local routing and legacy credential-file detection. Private integrations are documented in their owning repositories.
- `verify.d/40-cpa.{sh,ps1}` against a local fake hub (a Python HTTP server that checks a fake bearer token), a fake `op` and a fake home. With the matching key: 8 ok. With a different 1Password key: "deployed key differs" and the hub's 401 are reported as 2 FAILs, and the per-harness probes still run with the helper's token.
- `run_onchange_after_40-cpa-rebalancer-task.ps1.tmpl` renders for hub (3114 bytes, parses with 0 errors) and to whitespace for client. Its compare step on Beast reports the live task unchanged. The register path was not run, so the live task was not touched.
- `cpa-tools.toml.tmpl` renders `app_dir` from `versions.toml`. `.chezmoiignore` renders the cpa block for hub and client.

### [UNVERIFIED]

- An authenticated `/v1/models` against the real hub. `op` is not installed on Beast and no key value was read.
- The JSON shape of `op item template get "API Credential"`, and the `op item create -` stdin form against a real account.
- The `node:os` spellings for Windows and Linux in posture assertions. Only `macos` and `ios` appear on the docs page; `windows` and `linux` appear in the API's examples.
- Whether Tailscale applies grants to a node's traffic to its own serve address. The snippet grants `tag:cpa-hub -> tag:cpa-hub tcp:443` in case it does.
- Codex running a `.cmd` file directly as its auth `command`, Muse taking a helper, and CPA accepting `X-Api-Key` and `Authorization` together.
- The register path of the rebalancer run script (`Register-ScheduledTask` without `-RepetitionDuration` repeating indefinitely on Windows 11).
- The verify drop-ins' per-harness model-id prefixes.

## packages (2026-11-04)

### Versions resolved today

| Item | Pin | Source (queried 2026-11-04) |
|---|---|---|
| Claude Code | 2.1.318 | `npm view @anthropic-ai/claude-code version`; native installer `https://claude.ai/install.sh` / `install.ps1` accept a version argument |
| Codex | 0.166.0 | `npm view @openai/codex version`; GitHub release `rust-v0.166.0` (2026-10-29); mise `ls-remote codex` |
| Grok | 1.0.70 | `https://x.ai/cli/stable` (the installer's own channel pointer) returned `1.0.70`, so the pin is now registry-backed |
| Muse Code | 1.4.14-R7309.1 | `https://api.meta.ai/muse-code/channels/muse-stable` (the launcher's channel manifest) |
| mise | 2026.11.0 | https://github.com/jdx/mise/releases/tag/v2026.11.0 ; linux-x64 sha256 `71eb4f1b…79a94a9` matched `SHASUMS256.txt` |
| node | 24.22.2 (winget 24.22.1) | https://nodejs.org/dist/index.json ; `winget show OpenJS.NodeJS.LTS --versions` lists no 24.22.2 yet |
| uv | 0.13.7 (server 0.12.3) | https://github.com/astral-sh/uv/releases/tag/0.13.7 ; mise `ls-remote uv` lists 0.12.3 |
| gh | 2.103.3 | https://github.com/cli/cli/releases/tag/v2.103.3 ; winget `GitHub.cli` 2.103.3 |
| git | 2.56.0 / winget `Git.Git` 2.56.0.4 | winget manifest; foundation section above |
| Python | 3.13.18 (winget 3.13.17), 3.12.16 | python.org release API; python-build-standalone `20261026` has `cpython-3.13.18` and `cpython-3.12.16`; winget `Python.Python.3.12` stops at 3.12.10 |
| oh-my-posh | 31.9.1 | https://github.com/JanDeDobbeleer/oh-my-posh/releases/tag/v31.9.1 ; winget `JanDeDobbeleer.OhMyPosh` 31.9.1 (MSIX) |
| CodeRabbit CLI | 0.9.2 | `https://cli.coderabbit.ai/releases/latest/VERSION`; the installer's `BUNDLED_LINUX_VERSION` |
| Homebrew | casks `tailscale-app` 1.104.5, `1password-cli` 2.41.1 | https://formulae.brew.sh/api/cask/tailscale-app.json , https://formulae.brew.sh/api/cask/1password-cli.json |

### Primary docs used

- Claude Code install, version argument, native auto-update, `DISABLE_AUTOUPDATER`, Linux sandbox packages: https://code.claude.com/docs/en/setup
- Codex install methods (standalone installer, npm, Homebrew cask, GitHub release binaries): https://github.com/openai/codex/blob/rust-v0.166.0/README.md
- Grok installer flags (`bash -s <version>`, `-Version`, `GROK_CHANNEL`, `GROK_BIN_DIR`; edits `~/.bashrc` only when `$SHELL` names bash/zsh/fish): the scripts themselves, https://x.ai/cli/install.sh and https://x.ai/cli/install.ps1 (no separate docs page found)
- Muse install: https://developer.meta.com/ai/products/muse-code/ ; installer and launcher flags (`MUSE_NO_MODIFY_PATH`, `MUSE_INSTALL_DIR`, `MUSE_CHANNEL`, `MUSE_NO_AUTO_UPDATE`) from https://dev.meta.ai/install.sh , https://dev.meta.ai/install.ps1 and https://api.meta.ai/muse-launcher.sh
- mise: installer variables `MISE_VERSION`, `MISE_INSTALL_PATH`, `MISE_QUIET` (https://mise.run , https://mise.jdx.dev/installing-mise.html); global `conf.d/*.toml` (https://mise.jdx.dev/configuration.html); registry backends (https://mise.jdx.dev/registry.html); `mise install`, `mise where`, `mise exec`, `mise reshim` (https://mise.jdx.dev/cli/)
- uv: `uv python install` installs a versioned executable (`python3.12`) by default: https://docs.astral.sh/uv/guides/install-python/ , https://docs.astral.sh/uv/concepts/python-versions/#installing-python-executables (the `~/.local/bin` location was observed in the WSL test)
- CodeRabbit installer variables `CODERABBIT_VERSION`, `CODERABBIT_INSTALL_DIR`, `CR_CLI_SKIP_LOGIN`: https://cli.coderabbit.ai/install.sh ; CLI docs https://docs.coderabbit.ai/cli
- winget `install` / `upgrade` flags (`--id --exact --version --source --silent --scope --accept-package-agreements --accept-source-agreements --disable-interactivity`): https://learn.microsoft.com/windows/package-manager/winget/install , https://learn.microsoft.com/windows/package-manager/winget/upgrade
- Homebrew Bundle (`brew bundle check|install --file --no-upgrade`): https://docs.brew.sh/Brew-Bundle-and-Brewfile
- Tailscale Linux install script: https://tailscale.com/kb/1031/install-linux ; macOS options: https://tailscale.com/kb/1016/install-mac
- 1Password CLI per OS (winget, cask, apt/dnf repos): https://developer.1password.com/docs/cli/get-started/
- Windows registry PATH (`RegistryValueOptions.DoNotExpandEnvironmentNames`, `RegistryValueKind.ExpandString`): https://learn.microsoft.com/dotnet/api/microsoft.win32.registrykey.getvalue , `WM_SETTINGCHANGE`: https://learn.microsoft.com/windows/win32/winmsg/wm-settingchange
- chezmoi `includeTemplate`, `stat`, `env`, script order (`run_before_` runs before any file is written): https://www.chezmoi.io/reference/templates/functions/includeTemplate/ , https://www.chezmoi.io/reference/templates/functions/stat/ , https://www.chezmoi.io/user-guide/use-scripts-to-perform-actions/

### Tested today

- Rendered every packages template with chezmoi 2.74.0 on Windows (role client, machine beast-1) and in WSL (client `wsl-test`; server `server`). The three rendered `.ps1` files parse on Windows PowerShell 5.1 with 0 errors and 0 non-ASCII bytes. The four rendered `.sh` files pass `sh -n` under dash.
- Windows, dry run on Beast: 10-path found all 4 user PATH entries present and 1 Git Bash hook to add; 11-winget found uv, Python 3.13, oh-my-posh and Python 3.12 at pin, chezmoi and op missing, and 4 per-machine packages (git, gh, node, tailscale) behind their pins and waiting for the opt-in; 13-harnesses found claude 2.1.318, grok 1.0.70, codex 0.166.0 at pin and muse present.
- WSL, real run in a throwaway `HOME` under `/tmp`: mise 2026.11.0, node 24.22.2, uv 0.13.7, gh 2.103.3, oh-my-posh 31.9.1, codex 0.166.0 (mise), Python 3.13.18 and 3.12.16 (uv), CodeRabbit 0.9.2, Claude 2.1.318 and Grok 1.0.70 all installed; 12 changes, 0 failures. A second run made 0 changes. A login shell then resolved every tool to the expected path at its pin, through the `conf.d` pins and the mise shims. The verify drop-in passed 14 checks with 2 warnings (system git 2.53.0, no `op` in WSL); the preflight drop-in had 8 ok and 2 warnings (socat missing; `/usr/local/bin/claude` shadowing).
- Server rendering (`server`) uses the default uv pin; per-machine pins live in `versions.local.toml`. A local `versions.local.toml` overriding `gh = "2.100.0"` and `oh-my-posh = "skip"` reached both the mise config and the install list, and 11-system refused system packages on the server role.
- `muse.cmd` runs from Git Bash by full path; `command -v muse` finds nothing there, which is why the forwarder exists.

### [UNVERIFIED]

- Muse was not installed in the WSL test (415 MB download); only its channel manifest and installer flags were read. The Muse `install.ps1` path is not named on Meta's product page.
- No real winget install or upgrade ran (Beast's per-machine packages need the owner's UAC opt-in). That includes whether `winget upgrade --version` moves Git, gh, Node and Tailscale to an exact older-than-latest version, and the `--scope user` flag on `Python.Python.3.13`.
- The Windows run of the Claude, Grok and Muse `.ps1` installers as a child `powershell -File` with arguments: the tools were already at their pins, so no installer ran.
- macOS (`brew bundle`, cask `tailscale-app`, zsh startup files) and Rocky (`rpm -q`, uv 0.12.3 `python install`, private server PATH overrides) have not been run.
- The `WM_SETTINGCHANGE` broadcast after a user PATH change. No change was needed on Beast.
- Whether a Claude native build left past its pin is reverted cleanly by `claude install <older version>`.

## harness (2026-11-04)

### Versions resolved today

| Item | Pin | Source (queried 2026-11-04) |
|---|---|---|
| Claude Code | 2.1.318 (unchanged) | `npm view @anthropic-ai/claude-code version` |
| Codex CLI | 0.166.0 (unchanged) | `npm view @openai/codex version` |
| Grok CLI | 1.0.70 observed | `grok --version` on Beast; docs ship in the binary (`~/.grok/docs/user-guide/`) |
| Muse Code | 1.4.14 observed | `muse --version` on Beast |
| chezmoi (template functions) | 2.74.0 | `.tools/chezmoi.exe` and `.tools/linux/chezmoi`, checksum-verified by foundation |

### Primary docs used

Claude Code:
- `apiKeyHelper`: runs through `/bin/sh` on macOS/Linux and `cmd` on Windows; output sent as `X-Api-Key` and `Authorization: Bearer`; cached 5 minutes or `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`; rerun on 401/403 only when `ANTHROPIC_AUTH_TOKEN` is unset. https://code.claude.com/docs/en/settings-reference.md#apikeyhelper
- Credential precedence: `ANTHROPIC_AUTH_TOKEN` (2) outranks `apiKeyHelper` (4), so the merge deletes it. https://code.claude.com/docs/en/authentication.md#authentication-precedence
- `env`, `statusLine`, `enabledPlugins`, `extraKnownMarketplaces` (`source.source = "github"`, `source.repo`, `autoUpdate`), `outputStyle`, `ultracode`, `modelSettings`: https://code.claude.com/docs/en/settings-reference.md ; file locations and `~/.claude.json`: https://code.claude.com/docs/en/settings.md
- `claude mcp add --transport http --scope user <name> <url>` and `claude plugin install <plugin>@<marketplace> --scope user --json`, `claude plugin marketplace add <owner/repo>`: `--help` of 2.1.318.

Codex:
- `model_providers.<id>` fields (`base_url`, `wire_api = "responses"`, `supports_websockets`, `request_max_retries`, `stream_max_retries`, `env_key`, `experimental_bearer_token`) and `[model_providers.<id>.auth]` (`command`, `args`, `timeout_ms` default 5000, `refresh_interval_ms` default 300000): https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/config.schema.json (definitions `ModelProviderInfo`, `ModelProviderAuthInfo`); overview https://developers.openai.com/codex/config-reference
- `model`, `model_reasoning_effort`, `model_provider`, `mcp_servers.<name>.url`, `analytics.enabled`, `feedback.enabled`: same schema file.
- `codex mcp add|get|list|login`: `--help` of 0.166.0.

Grok (docs shipped with 1.0.70 in `~/.grok/docs/user-guide/`):
- `[auth] auth_provider_command` (stdout is the token), `auth_token_ttl` (needed for a bare token), `GROK_AUTH_EXPIRED`: `02-authentication.md`, "External Auth Provider".
- `[endpoints] cli_chat_proxy_base_url`, `[models] default`, `GROK_HOME`: `26-config-reference.md`.

Muse (1.4.14):
- `muse auth set --provider meta --api-key-stdin` (the only accepted way to pass a key): `muse auth set --help`.
- `endpoint_transport.{base_url,auth,proxy,ca_bundle,http_headers,env_http_headers}` and the rule that the Meta bearer is withheld from a non-Meta `base_url` unless settings pin both `base_url` and `auth = "bearer"`: strings in the 1.4.14 binary (no public docs found).

chezmoi 2.74.0 template functions: `setValueAtPath`, `deleteValueAtPath`, `fromJson`, `toPrettyJson`, `fromToml`, `toToml`, `includeTemplate`, `include`, `stat`, `lookPath`, `joinPath`, `shellQuote` (https://www.chezmoi.io/reference/templates/functions/ ; source https://github.com/twpayne/chezmoi/tree/v2.74.0/assets/chezmoi.io/docs/reference/templates/functions), `modify_` with `chezmoi:modify-template` (https://www.chezmoi.io/user-guide/manage-different-types-of-file/), `create_` (https://www.chezmoi.io/reference/source-state-attributes/), `execute-template --with-stdin` (https://www.chezmoi.io/reference/commands/execute-template/).

### Tested today

All against throwaway state: chezmoi 2.74.0 from `.tools/`, a fake home, fake `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME` dirs, and a local HTTP server on 127.0.0.1 that recorded only whether each request carried the expected fake token.
- **The token helper on Windows.** A `.cmd` helper given as a plain path works in all three harnesses: Claude Code 2.1.318 `apiKeyHelper` (quoted path, run by cmd; sent both `X-Api-Key` and `Authorization: Bearer`), Codex 0.166.0 `auth.command` (run directly; bearer on `/v1/models` and `/v1/responses`), Grok 1.0.70 `auth_provider_command` (bearer on every call). This settles the `.cmd` question in docs/cpa.md: no `cmd /c` wrapper is needed.
- **Merges against the live configs**, in memory, printing key paths only: Beast's Claude, Codex, Grok, Muse and T3 files, and WSL's Claude, Codex and Grok files. Every unmanaged key survives (WSL's 7 other hook events and 3 other PreToolUse groups; Codex `projects.*` trust entries). `env.ANTHROPIC_AUTH_TOKEN` and the `cpa-gui` provider with its bearer are removed, and no `sk-` string survives. A second pass over the output changes nothing.
- **Passthrough.** When the managed values are already right, the file comes back byte for byte, even reordered, re-indented and with extra keys. So `chezmoi verify` stays clean after a harness rewrites its own file. A fake-home `chezmoi apply` then `chezmoi verify` was clean, and clean again after re-indenting `settings.json`. Beast's T3 `settings.json` already passes through unchanged.
- **An unparsable file stops the apply** (`fromToml` error), so a harness file is never overwritten blind. Preflight names such a file.
- A rendered Codex `config.toml` loads in `codex mcp list` (0.166.0).
- `codex mcp add linear --url ...` starts an OAuth flow and blocks until a browser callback, and it replaces the whole `[mcp_servers.linear]` table (an `http_headers` key was dropped). So Codex MCP servers are set in the modify template.
- `claude mcp add` exits 1 with "already exists" on a rerun. `claude plugin install --json` prints `"outcome":"ok"`, with "already installed" on a rerun. A fresh config dir cannot install from `claude-plugins-official` until that marketplace is added, so it is in `extraKnownMarketplaces` and the script adds both GitHub marketplaces first. The plugin CLI writes `enabledPlugins` and `extraKnownMarketplaces` itself, in the same shape as the merge.
- Run scripts: the rendered `.ps1` files parse on Windows PowerShell 5.1. The MCP and plugin scripts ran twice on Windows (1 added then 1 present; 14 installed then 14 present, about 2 minutes), and the MCP script ran twice in WSL. The rendered `.sh` scripts pass `sh -n` under dash. Scripts that do not apply render to whitespace.
- `scripts/verify.d/30-harness.*` and `scripts/preflight.d/30-harness.*` ran under Windows PowerShell 5.1, Git Bash and WSL dash. Before an apply, Beast's verify shows the expected FAILs: the old URL, the inline key, and the `cpa-gui` provider.

### [UNVERIFIED]

- Whether CPA accepts a request carrying both `X-Api-Key` and `Authorization: Bearer` (what `apiKeyHelper` sends). No live key was used.
- `muse auth set --api-key-stdin` was not run: Muse has no documented config-dir override, so it could not be run without touching Beast's real `auth.json`. Also unverified: that it replaces only `providers.meta.api_key`, and that it trims the CRLF Windows PowerShell adds when piping.
- Whether Tailscale serve passes the Responses API WebSocket upgrade that `supports_websockets = true` asks Codex to use. If it does not, Codex should fall back to HTTP, but that is untested.
- The T3 Code paths on macOS (`~/.t3/userdata`) and the Muse binary path on macOS and Linux (`~/.local/bin/muse` is assumed).
- macOS and Rocky have not been run. Linux was covered only by rendering in WSL Ubuntu.

## integration (2026-11-04)

### Versions resolved today

| Item | Pin | Source (queried 2026-11-04) |
|---|---|---|
| chezmoi | 2.74.0, still the latest (published 2026-11-01T13:57:54Z) | `gh release view --repo twpayne/chezmoi` ; https://github.com/twpayne/chezmoi/releases/tag/v2.74.0 . Release checksums: windows_amd64.zip `13dee2831d37…b244ee7a95`, linux_amd64.tar.gz `1b98a567f726…553657b2374` (pinned in CI) |
| Grok | 1.0.70 (`~/.grok/bin/grok.exe` on Beast), used to test `[compat.claude]` | bundled docs `~/.grok/docs/user-guide/05-configuration.md`, `12-project-rules.md` |
| Python | 3.13 (Windows), 3.14.4 (WSL) for the render test's `tomllib` parse | https://docs.python.org/3.12/library/tomllib.html |

### Primary docs used

- Global flags `--source`, `--config`, `--persistent-state`, `--cache`, `--destination`, `--no-tty`: https://www.chezmoi.io/reference/command-line-flags/global/
- `chezmoi init` writes the rendered config to the `--config` path: https://www.chezmoi.io/reference/commands/init/
- `chezmoi apply --exclude=scripts --force`, `chezmoi status`, `chezmoi verify --exclude`: https://www.chezmoi.io/reference/commands/apply/ , https://www.chezmoi.io/reference/commands/status/ , https://www.chezmoi.io/reference/commands/verify/
- `chezmoi managed --include=scripts --path-style=absolute` and `chezmoi cat <target>` (prints a rendered script without running it): https://www.chezmoi.io/reference/commands/managed/ , https://www.chezmoi.io/reference/commands/cat/
- `.chezmoi.destDir` and `.chezmoi.homeDir`: https://www.chezmoi.io/reference/templates/variables/
- Template functions `fail`, `ternary`, `clean`, `regexMatch`, `has` (sprig): https://masterminds.github.io/sprig/flow_control.html , https://masterminds.github.io/sprig/defaults.html , https://masterminds.github.io/sprig/paths.html , https://masterminds.github.io/sprig/strings.html , https://masterminds.github.io/sprig/lists.html
- Claude Code `env.DISABLE_AUTOUPDATER`: https://code.claude.com/docs/en/setup (auto-updates) and https://code.claude.com/docs/en/settings-reference.md (`env`)
- Grok `[compat.claude]` cells: bundled `05-configuration.md`, "Harness compatibility" (Grok 1.0.70)
- GitHub Actions job layout reuses the foundation's pinned `actions/checkout` v7.0.1 and the checksum pattern of the gitleaks job.

### Tested today

- `sh scripts/render-test.sh` on Windows (Git Bash, chezmoi 2.74.0 Windows binary, checksum-verified into a temp dir): scenarios `hub:beast-1` (122 managed files, 89 paths) and `client:render-win:claude,codex` (113 managed files, 80 paths). Every check passed: init in test mode, apply, clean status and verify, no empty directories, idempotent second apply, placeholder key, no `sk-` key, 9 and 6 configs parse, 8 and 6 `.ps1` run scripts render and parse on PowerShell 5.1 (0 and 2 skipped by their guard), 31 of 31 skill junctions, second link run changed nothing, `op` never called.
- The same inside WSL Ubuntu (chezmoi 2.74.0 Linux binary): `client:beast-1-wsl` on `http://127.0.0.1:8317` (112 managed files), `server:server:claude,codex,grok` (111) and `client:render-codex-only:codex` (42 paths). Every check passed, including key mode 0600, 8, 7 and 7 `.sh` scripts under `sh -n`, and 31 of 31 symlinks. The server scenario's system-package script refuses to use sudo.
- Path diff between scenarios: the hub adds the public client-key tools and path configuration in `.cpa-tools/`; Windows adds `cpa-token.cmd`, the Git Bash `muse` forwarder and `.t3/userdata/` (3 files), and drops `.config/mise/`; server drops `.config/muse/` (Muse not selected).
- Guards: with `AGENT_ENV_NO_SECRETS=1` and the real home as destination, `chezmoi managed` and `chezmoi apply --dry-run` both fail in `.chezmoiignore`. `cpaUrl = http://127.0.0.1:8317` is refused on Windows and accepted on WSL.
- `chezmoi archive --include=scripts` does not contain run scripts, so the render test uses `chezmoi cat` per script instead.
- Grok 1.0.70 with a throwaway `HOME`/`USERPROFILE`: `[compat.claude] agents = false` and `rules = false` both show as `source: config` in `grok inspect --json`, but `~/.claude/Claude.md` stays in `projectInstructions` with either one. The documented switch does not work in this version, so agent-env sets neither (docs/skills.md).
- The `modify_` question from the foundation section is answered: after an apply into a fresh destination, `chezmoi status` and `chezmoi verify --exclude=scripts` are clean for every `modify_` target.
- `sh scripts/check.sh`: secret guard clean (214 tracked files), 18 shell scripts and 12 PowerShell files parse, the config renders for all three roles. gitleaks 8.30.1: 5 commits and the working tree, no leaks.

### [UNVERIFIED]

- The CI `render` job (Ubuntu, `osFlavour = linux`) has not run on GitHub, because the repo is not pushed. No `linux-*.paths` or `macos-*.paths` are recorded yet.
- macOS and Rocky (server) renders. Docker was not running, so a Rocky container was not tried.
- No run script except the skill links was executed by the integration test; their behaviour on a real apply is covered only by each area's own tests.

## packages: tools stage (2026-11-05)

### Pins resolved from primary registries today

The owner requested BEAST's versions where available, rather than an unrelated major upgrade. Existing pins remain unchanged. Each row below was queried on 2026-11-05.

| Tool | Pin | Registry or release source |
|---|---|---|
| pnpm | 12.9.1 (BEAST); latest is 12.16.1 | https://registry.npmjs.org/pnpm/12.9.1 |
| Bun | 1.4.4 | https://registry.npmjs.org/bun/1.4.4 |
| Temurin JDK | 25.0.4.1+1 (BEAST); mise `temurin-25.0.4+101.0.LTS`; winget `25.0.4.101` | https://api.github.com/repos/adoptium/temurin25-binaries/releases/tags/jdk-25.0.4.1%2B1 and https://github.com/microsoft/winget-pkgs/tree/master/manifests/e/EclipseAdoptium/Temurin/25/JDK/25.0.4.101 |
| Maven | 3.10.0 | https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml |
| ripgrep | 15.2.0 | https://api.github.com/repos/BurntSushi/ripgrep/releases/latest |
| Vercel | 65.10.0 (BEAST); latest is 65.11.0 | https://registry.npmjs.org/vercel/65.10.0 |
| Higgsfield CLI | existing `[skills.higgsfield] cli_version` 1.2.2, now installed | https://registry.npmjs.org/@higgsfield/cli/latest |
| T3 Code | 0.1.7 | https://api.github.com/repos/pingdotgg/t3code/releases/latest and https://github.com/microsoft/winget-pkgs/tree/master/manifests/t/T3Tools/T3Code/0.1.7 |
| JetBrains Toolbox | 3.9.1, build 3.9.1.89198; winget 3.9.1.0 | https://data.services.jetbrains.com/products/releases?code=TBA&latest=true&type=release and https://github.com/microsoft/winget-pkgs/tree/master/manifests/j/JetBrains/Toolbox/3.9.1.0 |
| Docker Desktop | 4.98.0, build 245422 | https://desktop.docker.com/win/main/amd64/appcast.xml and https://formulae.brew.sh/api/cask/docker-desktop.json |

Existing development pins were rechecked without changing them: Node 24.22.2 appears in https://nodejs.org/dist/index.json; Git 2.56.0 at https://api.github.com/repos/git/git/git/ref/tags/v2.56.0; gh 2.103.3 at https://api.github.com/repos/cli/cli/releases/tags/v2.103.3; uv 0.13.7 at https://api.github.com/repos/astral-sh/uv/releases/tags/0.13.7; Python 3.13.18 at https://www.python.org/downloads/release/python-31318/. Their existing Windows registry versions and Python minor-version policy are preserved. The CodeRabbit installer still binds signed version 0.9.2 and documents `CODERABBIT_VERSION`, `CODERABBIT_INSTALL_DIR`, and `CR_CLI_SKIP_LOGIN`: https://cli.coderabbit.ai/install.sh.

### Install methods and evidence

- T3 official GUI release assets are `T3-Code-0.1.7-{x64,arm64}.dmg` and `T3-Code-0.1.7-{x86_64,arm64}.AppImage`. The separate lowercase `t3-...tar.gz` assets are CLI distributions, so the GUI installer uses the uppercase assets. Their GitHub API SHA-256 digests are recorded in `versions.toml`. Windows uses winget's checksum-verified per-user installer. https://github.com/pingdotgg/t3code/releases/tag/v0.1.7.
- The upstream product name is `T3 Code (Beta)`, including the app/executable name: https://github.com/pingdotgg/t3code/blob/v0.1.7/apps/desktop/package.json. BEAST's existing install confirms `Programs/t3code/T3 Code (Beta).exe`. File metadata is read without starting the GUI. Linux uses AppImage extraction mode to avoid a FUSE prerequisite: https://docs.appimage.org/user-guide/run-appimages.html#extract-and-run-type-2-appimages.
- Toolbox's product API returns platform-specific DMG/tarball URLs and checksum links. The Linux x64 checksum was fetched from https://download.jetbrains.com/toolbox/jetbrains-toolbox-3.9.1.89198.tar.gz.sha256; the macOS x64 checksum from https://download.jetbrains.com/toolbox/jetbrains-toolbox-3.9.1.89198.dmg.sha256. Download, verify, and extract without launching. https://www.jetbrains.com/help/toolbox-app/toolbox-app-installation.html.
- Docker macOS stable build and architecture come from the official feed/cask above. Its checksum endpoint is `.../<build>/checksums.txt`, confirmed at https://desktop.docker.com/mac/main/arm64/245422/checksums.txt. A `Docker.dmg.sha256` request returned HTTP 403, so the implementation uses `checksums.txt`. Installation and first launch: https://docs.docker.com/desktop/setup/install/mac-install/. Linux stays manual: https://docs.docker.com/desktop/setup/install/linux/.
- Apache.Maven has no winget manifest directory (GitHub API returned 404). Windows uses Maven Central's official zip and SHA-512: https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.10.0/apache-maven-3.10.0-bin.zip.sha512. Unix uses mise `maven`. https://maven.apache.org/install.html.
- Temurin's MSI manifest uses `ADDLOCAL=ALL`, which includes the JDK environment features. The Windows script imports the MSI's `JAVA_HOME` through its environment refresh; Unix exports the pinned mise Java directory. mise's Java vendor format is confirmed in https://github.com/jdx/mise/blob/main/src/plugins/core/java.rs. No JRE is substituted for the JDK.
- npm package metadata confirms `pnpm`, `bun`, `higgsfield`, and `vercel` command names. The shared npm list reads the existing Higgsfield CLI pin, not its skill-pack version. Metadata probes read installed package.json directly to avoid npm cache writes and CLI login flows. On Unix they never invoke `mise exec` during a dry probe, because it could auto-install a missing Node.
- Isolated source/config/state/cache flags and package script rendering: https://www.chezmoi.io/reference/command-line-flags/global/ and https://www.chezmoi.io/reference/commands/execute-template/. The production tools stage copies an explicit allowlist; it never turns on the test-only `noSecrets` mode.

### [UNVERIFIED]

No installer or package manager changed BEAST's installed software. Actual winget installs/upgrades/UAC, Maven extraction and execution after installation, npm global installs, mise downloads for the added tools, native harness downloads, and CodeRabbit installation remain untested. macOS DMG attachment/copying and Linux AppImage/Toolbox runtime behavior remain untested. Desktop first launch, sign-in, Docker engine integration, and Toolbox IDE installation require the owner. Linux graphical runtime libraries depend on the distribution. macOS and Linux desktop branches are covered by synthetic rendering and shell syntax/lint checks only. Windows MSIX rejection and environment broadcasts retain their existing implementation and were not triggered in this change.

### Validation for this change

- `sh scripts/check.sh` passes on Git Bash and WSL. Git Bash includes Windows PowerShell 5.1 parsing/ASCII checks. Both runs include shellcheck, config rendering, fake-op tests, and the new tools-stage tests.
- `sh scripts/render-test.sh` passes on Git Bash (2 scenarios, 33 OK checks, 0 FAIL) and WSL (3 scenarios, 53 OK checks, 0 FAIL). Both suites confirm `op` was never called and that a second apply into the throwaway destination changes nothing.
- Focused tools tests run 2 native dry stages per OS and 6 desktop role/platform renders per OS. They confirm all four harness defaults, an unusable normal config cannot interfere, and no package files are deployed in a dry run. Active Linux/macOS desktop scripts pass `sh -n` and shellcheck. The Windows Maven fixture uses a fake archive binary, proves the stable launcher runs it, and confirms a second script run reports zero changes. It never downloads or installs Maven.
- All scratch homes/configs are under `.tools/` or render-test's temporary destinations. No normal apply, package installation, login, or push ran on BEAST.


## Packages review corrections (2026-11-05)

Primary sources rechecked for these fixes:

- mise's Java metadata lists vendor `temurin`, version `25.0.4+101.0.LTS`, runtime `25.0.4.1+1-LTS`, and JDK images for Linux x64/arm64 and macOS x64/arm64. Exact URLs: https://mise-java.jdx.dev/jvm/ga/linux/x86_64.json, https://mise-java.jdx.dev/jvm/ga/linux/aarch64.json, https://mise-java.jdx.dev/jvm/ga/macosx/x86_64.json, and https://mise-java.jdx.dev/jvm/ga/macosx/aarch64.json. The macOS platform key is `macosx`. Windows HTTP requests to bare URLs returned 403; a cache-busting query succeeded. WSL has no mise binary, so `mise ls-remote java` was unavailable. `tools-test.py` now checks exact metadata IDs and runtime versions when the endpoints answer, and prints a skip when offline.
- The Temurin winget manifest confirms `PackageVersion: 25.0.4.101`: https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/e/EclipseAdoptium/Temurin/25/JDK/25.0.4.101/EclipseAdoptium.Temurin.25.JDK.yaml. Runtime, winget, and mise override keys are distinct.
- T3 v0.1.7 assets and SHA-256 digests were re-resolved from https://api.github.com/repos/pingdotgg/t3code/releases/tags/v0.1.7. The Debian assets are `T3-Code-0.1.7-amd64.deb` (`e1373f8047ba582f2e40aff4b34b57d9a355513d4fb47c34d49d11b5c870f9fe`) and `T3-Code-0.1.7-arm64.deb` (`94e0c9b3b5e9735f8570df6da1feb6f89dc9c0e1c842e8dfbd020e957345e0ca`). Reading the amd64 package's control archive confirms package name `t3code` and version `0.1.7`. Existing DMG/AppImage digests still match the release API. No package was installed.
- Electron Builder embeds `X-AppImage-Version` in the AppImage desktop entry, and its updater overwrites a versionless AppImage filename: https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/targets/linux/appimage/AppImageTarget.ts and https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppImageUpdater.ts. The metadata probe invokes only AppImage extraction, never AppRun or Electron. Ubuntu's unprivileged-user-namespace restriction is documented at https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces. The apt branch uses the Debian sandbox setup; other AppImage desktops retain their administrator's sandbox policy.
- Toolbox's API still resolves version `3.9.1`, build `3.9.1.89198`, and architecture-specific checksum links: https://data.services.jetbrains.com/products/releases?code=TBA&latest=true&type=release. Streaming the arm64 tarball confirms top-level `jetbrains-toolbox-3.9.1.89198-arm64/` and `bin/build.txt` containing `3.9.1.89198`: https://download.jetbrains.com/toolbox/jetbrains-toolbox-3.9.1.89198-arm64.tar.gz. No GUI was started.
- Docker's macOS feed still resolves `4.98.0` build `245422`: https://desktop.docker.com/mac/main/arm64/appcast.xml. Writable `/Applications` copies keep the user's ownership; protected destinations use a current sudo ticket and a staged bundle replacement.
- CI inspection confirms `guard` installs shellcheck only and `render` installs chezmoi. `check.sh` now gates template and tools-stage checks using the same executable lookup, including `AGENT_ENV_CHEZMOI`. No workflow file changed.

### [UNVERIFIED] real installers

Actual UAC/winget, sudo ticket expiry on macOS, DMG mounting, apt installation, Electron sandbox startup, and Toolbox self-update behavior have not been run on real desktops. Regression fixtures exercise the rendered scripts and metadata/version decisions in throwaway homes. No host software, real home, authentication, or production data was changed.


### Validation of the review corrections

- Git Bash: `sh scripts/check.sh` passes all 6 check groups, including shellcheck 0.11.0, 22 POSIX shell files, Windows PowerShell 5.1 parsing of 16 ASCII-only files, and 17 tools-test result groups. WSL passes 5 check groups and 15 tools-test result groups; the Windows-only parser group is skipped there.
- `sh scripts/render-test.sh`: Git Bash passes 33 checks across 2 scenarios; WSL passes 53 checks across 3 scenarios. There are zero failures. WSL uses a native temporary checkout; Windows renders from a disposable copy so all test destinations remain under `.tools/`.
- CI guard simulation: `sh scripts/check.sh --no-guard` passes with both chezmoi and `AGENT_ENV_CHEZMOI` absent. Template and tools-stage groups explicitly skip. Git Bash runs 3 groups and skips 2; WSL runs 2 and skips 3, including its unavailable Windows parser. Shellcheck remains available in both simulations.
- Fixtures exercise failed/empty/successful/skipped Java lookup; separate Java runtime and winget overrides; all desktop newer-version no-download paths; Unix and Windows missing/older/newer verify decisions; Docker skip; replacement of stale bundle contents without sudo; Windows desktop script ordering and Docker file metadata preflight; real arm64 Toolbox extraction from a fake checksum-verified vendor archive; and checksum rejection before the mocked Debian apt install.
- The real Unix entry point is exercised with fake sudo/chezmoi/mise, including the bootstrap downloader path. Its keepalive and sleep process stop on exit. No real package manager runs. Chezmoi bootstrap is isolated in a subshell so its downloader trap cannot replace the stage cleanup trap.
- Live metadata confirms the Java ID on all four platforms. Substituting the original invalid ID makes the guard fail. A checksum-verified T3 0.1.7 x64 AppImage was run in WSL only with `--appimage-extract '*.desktop'`; the real desktop entry reports version `0.1.7`. Electron/AppRun was never launched. The Debian control archive and post-install script were read: the package supplies `/usr/bin/t3code`, configures `chrome-sandbox`, and installs its supported Ubuntu AppArmor profile.
- The suites delete their fake homes and runtime scratch state. No software was installed on the test host and no real-home apply ran.

## Package installer review fixes (2026-11-05)

- Rechecked all six T3 v0.1.7 DMG, AppImage, and Debian SHA-256 digests against https://api.github.com/repos/pingdotgg/t3code/releases/tags/v0.1.7. They match `versions.toml`. A different version override now requires six matching digest overrides from the same block; missing or malformed values fail before installation.
- The pinned chezmoi WinGet manifest uses ZIP archives with `NestedInstallerType: portable` on x86, x64, and arm64: https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/t/twpayne/chezmoi/2.74.0/twpayne.chezmoi.installer.yaml. Bootstrap explicitly requests `--scope user` on every role. Scope and portable installation behavior: https://learn.microsoft.com/en-us/windows/package-manager/winget/install and https://learn.microsoft.com/en-us/windows/package-manager/winget/portable.
- WinGet chooses upgrade from its installed-package inventory, using https://learn.microsoft.com/en-us/windows/package-manager/winget/list. A command found on PATH alone does not establish WinGet ownership. Temurin's MSI remains responsible for `JAVA_HOME`; the script no longer derives a persistent value from an arbitrary `javac.exe`.
- Regression fixtures run the Unix npm loop, Windows inventory and npm completion decisions, repeated PATH snapshots, T3 override validation and precedence, and the Windows bootstrap entry point with fake commands. All homes and writes are disposable. Actual WinGet/UAC, MSI environment writes, npm downloads, and desktop installation remain [UNVERIFIED].
