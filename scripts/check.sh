#!/bin/sh
# Every local check for a change to this repo, in one command. CI runs the same.
#
# Usage: sh scripts/check.sh [--no-guard]
#   1. scripts/secret-guard.sh             (skipped with --no-guard; CI runs it as its own step)
#   2. POSIX syntax of every shell script  (sh -n; shellcheck too when installed)
#   3. PowerShell syntax of every .ps1     (pwsh or Windows PowerShell parser, plus ASCII-only)
#   4. chezmoi templates render            (only when chezmoi is installed: the config template
#                                           for each role with fixed answers, then .chezmoiignore)
set -u
REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$REPO" || exit 2
rc=0
step() { printf '\n== %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; rc=1; }

if [ "${1:-}" != "--no-guard" ]; then
  step "secret guard"
  sh scripts/secret-guard.sh || rc=1
fi

step "shell syntax"
# Shell files: a sh/bash/dash shebang, or a first line "# shellcheck shell=sh" (sourced libs
# and drop-ins). Templates (*.tmpl) are checked by rendering, not here.
sh_files=$(git ls-files 'scripts/*' 'home/*' | while IFS= read -r f; do
  case "$f" in *.ps1|*.md|*.list|*.tmpl|*.toml|*.json|*.yml|*.yaml) continue ;; esac
  head -n 1 "$f" | grep -Eq '^#!.*(/sh|bash|dash)|^# shellcheck shell=sh' && echo "$f"
done)
n=0
for f in $sh_files; do
  n=$((n + 1))
  sh -n "$f" || bad "sh -n $f"
done
echo "  $n shell scripts parsed"
if command -v shellcheck >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  shellcheck -s sh -S warning $sh_files || bad "shellcheck"
else
  echo "  shellcheck not installed: skipped"
fi

step "PowerShell syntax"
ps=''
if command -v pwsh >/dev/null 2>&1; then ps=pwsh
elif command -v powershell.exe >/dev/null 2>&1; then ps=powershell.exe
fi
if [ -n "$ps" ]; then
  "$ps" -NoProfile -NonInteractive -Command '
    $bad = 0; $n = 0
    foreach ($f in (git ls-files "*.ps1")) {
      if (-not $f) { continue }
      $p = (Resolve-Path -LiteralPath $f).Path
      $n++; $t = $null; $e = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e)
      if ($e.Count -gt 0) { $bad++; Write-Output ("  FAIL  parse " + $f + ": " + $e[0].Message) }
      foreach ($b in [System.IO.File]::ReadAllBytes($p)) { if ($b -gt 127) { $bad++; Write-Output ("  FAIL  non-ASCII byte in " + $f); break } }
    }
    Write-Output ("  " + $n + " PowerShell files parsed")
    if ($bad -gt 0) { exit 1 }' || rc=1
else
  echo "  no PowerShell found: skipped"
fi

step "chezmoi templates"
cz=${AGENT_ENV_CHEZMOI:-chezmoi}
if [ -z "${AGENT_ENV_CHEZMOI:-}" ] && ! command -v "$cz" >/dev/null 2>&1; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) cz=$(cygpath -m "$REPO/.tools/chezmoi.exe") ;;
    *) cz="$REPO/.tools/linux/chezmoi" ;;
  esac
fi
if command -v "$cz" >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  for role in client hub server; do
    for mode in account service default; do
      op_mode=$mode
      [ "$mode" != default ] || op_mode=''
      if AGENT_ENV_ROLE=$role AGENT_ENV_MACHINE=check AGENT_ENV_CPA_URL=https://hub.example.com \
         AGENT_ENV_OP_VAULT='' AGENT_ENV_OP_MODE=$op_mode OP_SERVICE_ACCOUNT_TOKEN='' AGENT_ENV_HARNESSES=claude,codex,grok,muse \
         "$cz" --source "$REPO" --config "$tmp/in.toml" --persistent-state "$tmp/s.boltdb" --no-tty \
           execute-template --init --file home/.chezmoi.toml.tmpl > "$tmp/c.toml"; then
        want_mode=$mode; [ "$mode" != default ] || want_mode=service
        want_vault=agent-env
        if [ "$want_mode" = service ] && [ "$role" != hub ]; then want_vault=agent-env-check; fi
        grep -q "opMode = \"$want_mode\"" "$tmp/c.toml" || bad "opMode default for role=$role mode=$mode"
        grep -q "opVault = \"$want_vault\"" "$tmp/c.toml" || bad "opVault default for role=$role mode=$mode"
        echo "  config renders for role=$role mode=$mode"
        "$cz" --source "$REPO" --config "$tmp/c.toml" --persistent-state "$tmp/s.boltdb" \
          execute-template --file home/.chezmoiignore > /dev/null || bad ".chezmoiignore does not render for role=$role mode=$mode"
      else
        bad "config template fails for role=$role mode=$mode"
      fi
    done
  done
  # No configured remark: the default must differ between Windows and WSL on any PC.
  if AGENT_ENV_ROLE=client AGENT_ENV_MACHINE='' AGENT_ENV_CPA_URL=https://hub.example.com \
     AGENT_ENV_OP_VAULT='' AGENT_ENV_OP_MODE=service AGENT_ENV_HARNESSES=codex \
     AGENT_ENV_NO_SECRETS=1 "$cz" init --source "$REPO" --config "$tmp/default.toml" \
       --persistent-state "$tmp/default.boltdb" --cache "$tmp/cache" --destination "$tmp/home" \
       --no-tty --promptDefaults >/dev/null; then
    want_machine=$(hostname | cut -d. -f1 | tr 'A-Z' 'a-z')
    if grep -q 'osFlavour = "wsl"' "$tmp/default.toml"; then want_machine="$want_machine-wsl"; fi
    grep -q "machine = \"$want_machine\"" "$tmp/default.toml" || bad "default machine remark"
    echo "  default machine remark checked"
  else bad "default machine template failed"; fi
  rm -rf "$tmp"
else
  echo "  chezmoi not installed: skipped"
fi

step "1Password flows (fake op only)"
py=''
for p in python3 python py; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' >/dev/null 2>&1; then py=$p; break; fi
done
if [ -n "$py" ]; then "$py" -I scripts/op-test.py || bad "fake-op tests"
else bad "Python 3.11+ is required for fake-op tests"; fi

step "tools stage (dry runs only)"
if ! command -v "$cz" >/dev/null 2>&1; then echo "  chezmoi not installed: skipped"
elif [ -n "$py" ]; then AGENT_ENV_CHEZMOI="$cz" "$py" -I scripts/tools-test.py || bad "tools-stage tests"
else bad "Python 3.11+ is required for tools-stage tests"; fi

printf '\n'
if [ "$rc" -eq 0 ]; then echo "check: all passed"; else echo "check: failures above"; fi
exit "$rc"
