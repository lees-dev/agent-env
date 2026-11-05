# Testing a change without touching a real home

`scripts/render-test.sh` renders and applies the whole source state into throwaway destinations. It never reads 1Password, never runs a run script against the real home, and never writes outside its scratch directory (from `mktemp -d`; it refuses one inside the repo). CI runs it on `ubuntu-24.04` (`.github/workflows/secret-scan.yml`, job `render`). Run it yourself on Windows (Git Bash) and inside WSL before you commit a change to `home/`.

```sh
sh scripts/render-test.sh                                    # this OS's default scenarios
sh scripts/render-test.sh --chezmoi /path/to/chezmoi         # a portable binary (see below)
sh scripts/render-test.sh client:x:claude,codex              # one scenario: role:machine[:harnesses[:cpaUrl]]
sh scripts/render-test.sh --update                           # re-record tests/render/*.paths after an intended change
```

## Test mode: `AGENT_ENV_NO_SECRETS=1`

The script runs `chezmoi init` with `AGENT_ENV_NO_SECRETS=1`, so the config template sets the data key `noSecrets = true`. Then:

- `home/.chezmoitemplates/secrets/cpa-client-key` returns the fixed string `agent-env-no-secrets-placeholder` instead of calling `onepasswordRead`. op is never run.
- Run scripts get `AGENT_ENV_NO_SECRETS=1` in their environment (`scriptEnv`).
- `home/.chezmoiignore` and the secret partial both `fail` when the destination is the real home directory. A machine initialised in test mode cannot apply, so a placeholder can never replace a real key.

The script also puts a fake `op` (and `op.cmd` on Windows) first on `PATH`; it records each call and exits 99. Any call fails the run.

The default render scenarios use service mode. Unix scenarios also check the mode-0600 env.d loader with a dummy persisted token in the throwaway home. `sh scripts/check.sh` runs `scripts/op-test.py` with a separate fake `op`: minting inherits a dummy service token while the parent's stdin pipe stays open. It checks dry-run, create/read/register, duplicate items, failed read-back, hub and device scope, and refusal to sign in without a token. Windows also checks that the hub roster finds keys across device vaults. It also checks saved-token loading before preflight, apply, and verify, rejects unsafe Unix token files, and mocks Windows User environment reads. It never uses the real account or home.

## What one scenario checks

1. `chezmoi init` with a scratch `--config`, `--persistent-state`, `--cache` and `--destination`.
2. `chezmoi apply --exclude=scripts --force`, then `status` is empty, `verify` passes, and no empty directory is left. A harness that is not selected gets no `~/.<harness>` directory at all.
3. A second apply changes nothing (sha256 of every file, and every link target).
4. `~/.config/agent-env/cpa-key` holds the placeholder (mode 0600 off Windows), no file holds an `sk-` key, and every rendered `.json` and `.toml` file parses (Python 3.11+ for `tomllib`; skipped without it).
5. Every run script this machine would run is rendered with `chezmoi cat` (never run) and parsed: `sh -n` for `.sh`, the PowerShell parser plus an ASCII-only check for `.ps1`. Scripts whose guard renders them empty are counted as skipped.
6. When `claude` is selected, the rendered skill-link script runs twice against the scratch destination (it writes under `.chezmoi.destDir`). Every canonical skill gets a junction (Windows) or symlink, and the second run changes nothing and backs up nothing.
7. The rendered paths match `tests/render/<os>-<role>-<machine>.paths`. Each skill folds to one line, so adding a file inside a skill does not need a re-record; adding, removing or moving a deployed file does.

Default scenarios:

| OS | Scenarios |
|---|---|
| Windows (Git Bash) | `hub:beast-1` (all four harnesses), `client:render-win:claude,codex` |
| WSL | `client:beast-1-wsl:claude,codex,grok,muse:http://127.0.0.1:8317`, `server:render-server:claude,codex,grok`, `client:render-codex-only:codex` |
| Linux | `server:render-server:claude,codex,grok`, `client:render-linux` |
| macOS | `client:render-mac` |

`tests/render/` holds the Windows and WSL lists today. Linux and macOS print an INFO line until someone records theirs with `--update` on that OS.

## A portable chezmoi

Nothing needs to be installed globally. Download the pinned release (`versions.toml` `[tools.chezmoi]`) into a scratch directory, check it against the release's `checksums.txt`, and pass it with `--chezmoi`:

```sh
v=2.74.0; d=$(mktemp -d); cd "$d"
base=https://github.com/twpayne/chezmoi/releases/download/v$v
curl -fsSLO "$base/chezmoi_${v}_checksums.txt"
curl -fsSLO "$base/chezmoi_${v}_linux_amd64.tar.gz"          # or chezmoi_${v}_windows_amd64.zip
grep " chezmoi_${v}_linux_amd64.tar.gz\$" "chezmoi_${v}_checksums.txt" | sha256sum -c -
tar -xzf "chezmoi_${v}_linux_amd64.tar.gz" chezmoi
```

In WSL, a binary on `/mnt/c` is copied into the scratch directory before it runs. The script runs the repo from `/mnt/c` read-only, apart from `--update`.

## What it does not cover

- Run scripts are rendered and parsed, never executed, except the skill-link script. Package installs, `claude mcp add`, plugin installs, Muse auth and the rebalancer task need a real machine (AGENTS.md runbook, with a backup).
- Templates that read the live home (`lookPath "oh-my-posh"`, `versions.local.toml`) see the machine running the test.
- macOS and Rocky (server) have not been run locally. CI covers Ubuntu (`osFlavour = linux`, `distroFamily = debian`).
