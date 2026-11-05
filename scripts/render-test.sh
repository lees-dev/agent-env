#!/bin/sh
# Render and apply this repo into throwaway destinations, with no 1Password and without
# touching the real home directory. Git Bash on Windows, WSL, Linux and macOS (docs/testing.md).
#
# Usage: sh scripts/render-test.sh [--chezmoi PATH] [--keep] [--update] [SCENARIO ...]
#   SCENARIO   role:machine[:harnesses[:cpaUrl]], e.g. hub:beast-1 or client:x:claude,codex
#              Default: the scenarios for this OS (see default_scenarios below).
#   --chezmoi  the chezmoi binary to use. Default: $AGENT_ENV_CHEZMOI, then chezmoi on PATH,
#              then .tools/chezmoi.exe (Windows) or .tools/linux/chezmoi (Linux).
#   --keep     keep the scratch directory and print its path.
#   --update   rewrite the expected path lists in tests/render/ instead of comparing with them.
#
# For each scenario, in a fresh scratch dir outside the repo:
#   1. chezmoi init with a scratch config, state, cache and destination, AGENT_ENV_NO_SECRETS=1
#   2. chezmoi apply --exclude=scripts --force; then status and verify must be clean, and no
#      empty directory may be left (an unselected harness gets no ~/.<harness> at all)
#   3. a second apply changes nothing (sha256 of every file and link target)
#   4. the CPA key file holds the placeholder (mode 0600 off Windows); no sk- key anywhere;
#      every rendered .json / .toml config parses (when python is available)
#   5. every run script renders (chezmoi cat; nothing is run) and parses: sh -n, PowerShell
#      parser + ASCII
#   6. the skill-link run script runs twice against the scratch destination (when claude is
#      selected): every canonical skill gets a link, and the second run changes nothing
#   7. the rendered paths match tests/render/<os>-<role>-<machine>.paths
# A fake `op` comes first on PATH for the whole run; any call to it is a failure.
# Output: counts and relative paths only. Exit 0 when every check passed.
set -u

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
KEEP=0; UPDATE=0; CZ=${AGENT_ENV_CHEZMOI:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --chezmoi) CZ=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --update) UPDATE=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

case "$(uname -s)" in
  Darwin) OSF=macos ;;
  Linux) if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then OSF=wsl; else OSF=linux; fi ;;
  MINGW*|MSYS*|CYGWIN*) OSF=windows ;;
  *) echo "unsupported OS" >&2; exit 2 ;;
esac

default_scenarios() {
  case "$OSF" in
    windows) echo "hub:beast-1 client:render-win:claude,codex" ;;
    wsl) echo "client:beast-1-wsl:claude,codex,grok,muse:http://127.0.0.1:8317 server:render-server:claude,codex,grok client:render-codex-only:codex" ;;
    linux) echo "server:render-server:claude,codex,grok client:render-linux" ;;
    macos) echo "client:render-mac" ;;
  esac
}
# Word splitting is intended: one positional argument per space-separated scenario (no glob chars).
# shellcheck disable=SC2046
[ $# -gt 0 ] || set -- $(default_scenarios)

# Windows binaries need Windows paths; everything else takes POSIX paths.
wp() { if [ "$OSF" = windows ]; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

if [ -z "$CZ" ]; then
  if command -v chezmoi >/dev/null 2>&1; then CZ=$(command -v chezmoi)
  elif [ "$OSF" = windows ] && [ -f "$REPO/.tools/chezmoi.exe" ]; then CZ="$REPO/.tools/chezmoi.exe"
  elif [ -f "$REPO/.tools/linux/chezmoi" ] && [ "$OSF" != macos ] && [ "$OSF" != windows ]; then CZ="$REPO/.tools/linux/chezmoi"
  else echo "no chezmoi: pass --chezmoi PATH (docs/testing.md)" >&2; exit 2
  fi
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t ae-render)
case "$TMP/" in "$REPO"/*) echo "refusing: scratch dir is inside the repo" >&2; exit 2 ;; esac
cleanup() { if [ "$KEEP" = 1 ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi; }
trap cleanup EXIT INT TERM

# A /mnt/c binary in WSL may lack the exec bit: run a private copy.
if [ ! -x "$CZ" ] || [ "$OSF" = wsl ]; then cp "$CZ" "$TMP/chezmoi-bin" && chmod +x "$TMP/chezmoi-bin" && CZ="$TMP/chezmoi-bin"; fi
pin=$(awk '/^\[tools.chezmoi\]/{s=1;next} /^\[/{s=0} s&&/^version/{gsub(/.*= *"|".*/,"");print;exit}' "$REPO/versions.toml")
have=$("$CZ" --version 2>/dev/null | sed -n 's/.*v\([0-9][0-9.]*\),.*/\1/p')

# The fake op: records any call and fails, so a secret read can never succeed silently.
mkdir -p "$TMP/fakebin"
printf '#!/bin/sh\necho called >> "%s/op-called"\nexit 99\n' "$TMP" > "$TMP/fakebin/op"
chmod +x "$TMP/fakebin/op"
if [ "$OSF" = windows ]; then
  printf '@echo off\r\necho called>> "%s\\op-called"\r\nexit /b 99\r\n' "$(cygpath -w "$TMP")" > "$TMP/fakebin/op.cmd"
fi
PATH="$TMP/fakebin:$PATH"; export PATH

PY=''
for p in python3 python py; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' >/dev/null 2>&1; then PY=$p; break; fi
done
PS=''
if [ "$OSF" = windows ]; then
  if command -v powershell.exe >/dev/null 2>&1; then PS=powershell.exe; fi
elif command -v pwsh >/dev/null 2>&1; then PS=pwsh
fi

TOTAL_FAIL=0
fail() { printf '  FAIL  %s\n' "$*"; TOTAL_FAIL=$((TOTAL_FAIL + 1)); }
ok() { printf '  OK    %s\n' "$*"; }
info() { printf '  INFO  %s\n' "$*"; }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
# tree_manifest <dir>: "<relpath> <sha256 or ->target>" for every file and symlink, sorted.
tree_manifest() {
  (cd "$1" && find . \( -type f -o -type l \) | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf '%s ->%s\n' "$f" "$(readlink "$f")"; else printf '%s %s\n' "$f" "$(sha < "$f")"; fi
  done)
}
# tree_paths <dir>: relative paths, with each skill folded to one line, for tests/render/.
tree_paths() {
  (cd "$1" && find . \( -type f -o -type l \) | sed 's|^\./||' \
    | sed -e 's|^\(\.agents/skills/[^/]*\)/.*|\1/|' -e 's|^\(\.claude/skills/[^/]*\)$|\1 (link)|' | LC_ALL=C sort -u)
}

echo "agent-env render test: os=$OSF chezmoi=$have (pin $pin) python=${PY:-none} powershell=${PS:-none}"
[ "$have" = "$pin" ] || fail "chezmoi $have is not the pin $pin"

for sc in "$@"; do
  role=$(echo "$sc" | cut -d: -f1); machine=$(echo "$sc" | cut -d: -f2)
  hs=$(echo "$sc" | cut -s -d: -f3); url=$(echo "$sc" | cut -s -d: -f4-)
  [ -n "$hs" ] || hs=claude,codex,grok,muse
  [ -n "$url" ] || url=https://beast-1.tail7f661e.ts.net
  name="$OSF-$role-$machine"
  op_mode=${AGENT_ENV_OP_MODE:-service}
  op_vault=agent-env
  if [ "$op_mode" = service ] && [ "$role" != hub ]; then op_vault="agent-env-$machine"; fi
  S="$TMP/$name"; D="$S/home"; mkdir -p "$D"
  printf '\n== %s (harnesses %s)\n' "$name" "$hs"
  set -- --source "$(wp "$REPO")" --config "$(wp "$S/chezmoi.toml")" --persistent-state "$(wp "$S/state.boltdb")" \
    --cache "$(wp "$S/cache")" --destination "$(wp "$D")" --no-tty
  if ! AGENT_ENV_ROLE=$role AGENT_ENV_MACHINE=$machine AGENT_ENV_CPA_URL=$url AGENT_ENV_OP_VAULT=$op_vault \
       AGENT_ENV_OP_MODE=$op_mode AGENT_ENV_HARNESSES=$hs AGENT_ENV_NO_SECRETS=1 \
       "$CZ" init "$@" > "$S/init.out" 2>&1; then
    fail "chezmoi init"; sed -n '1,5p' "$S/init.out"; continue
  fi
  grep -q 'noSecrets = true' "$S/chezmoi.toml" && ok "init (noSecrets = true)" || fail "init did not set noSecrets"
  nman=$("$CZ" managed "$@" --include=files,symlinks 2>/dev/null | wc -l | tr -d ' ')
  if "$CZ" apply "$@" --exclude=scripts --force > "$S/apply.out" 2>&1; then ok "apply ($nman managed files)"
  else fail "apply"; sed -n '1,8p' "$S/apply.out"; continue
  fi
  nst=$("$CZ" status "$@" --exclude=scripts 2>/dev/null | wc -l | tr -d ' ')
  [ "$nst" = 0 ] && ok "status clean after apply" || fail "status lists $nst entries after apply"
  "$CZ" verify "$@" --exclude=scripts >/dev/null 2>&1 && ok "chezmoi verify" || fail "chezmoi verify"
  nemp=$(find "$D" -mindepth 1 -type d -empty | wc -l | tr -d ' ')
  [ "$nemp" = 0 ] && ok "no empty directories" || { fail "$nemp empty directories"; find "$D" -mindepth 1 -type d -empty | sed "s|^$D/|    |" | head -n 5; }
  tree_manifest "$D" > "$S/m1"
  "$CZ" apply "$@" --exclude=scripts --force > /dev/null 2>&1 || fail "second apply"
  tree_manifest "$D" > "$S/m2"
  cmp -s "$S/m1" "$S/m2" && ok "second apply changed nothing ($(wc -l < "$S/m1" | tr -d ' ') entries)" || fail "second apply changed files"

  k="$D/.config/agent-env/cpa-key"
  if [ -f "$k" ] && [ "$(cat "$k")" = agent-env-no-secrets-placeholder ]; then ok "cpa-key holds the placeholder"
  else fail "cpa-key missing or not the placeholder"; fi
  if [ "$OSF" != windows ] && [ -f "$k" ]; then
    m=$(ls -l "$k" | cut -c1-10)
    [ "$m" = "-rw-------" ] && ok "cpa-key mode 0600" || fail "cpa-key mode $m"
  fi
  if [ "$OSF" != windows ]; then
    loader="$D/.config/agent-env/env.d/40-cpa-op.sh"
    if [ -f "$loader" ] && [ "$(ls -l "$loader" | cut -c1-10)" = '-rw-------' ]; then
      ok "token loader present (0600; mode $op_mode)"
      mkdir -p "$D/.config/op"
      (umask 077; printf '%s\n' render-test-token > "$D/.config/op/agent-env-token")
      # Exercise the deployed loader with a dummy token, without inheriting the host token.
      expected_token=''
      [ "$op_mode" != service ] || expected_token=render-test-token
      if HOME="$D" OP_SERVICE_ACCOUNT_TOKEN='' AE_EXPECTED_TOKEN="$expected_token" sh -c '. "$HOME/.config/agent-env/env.sh"; [ "${OP_SERVICE_ACCOUNT_TOKEN:-}" = "$AE_EXPECTED_TOKEN" ]'; then
        ok "persisted token handling in a fresh shell (mode $op_mode)"
      else fail "persisted token handling (mode $op_mode)"; fi
      rm -f "$D/.config/op/agent-env-token"; rmdir "$D/.config/op"
    else fail "token loader missing or not mode 0600"; fi
  fi
  nkey=$(grep -rlE 'sk-[A-Za-z0-9_-]{20,}' "$D" 2>/dev/null | wc -l | tr -d ' ')
  [ "$nkey" = 0 ] && ok "no sk- key in the rendered tree" || fail "$nkey rendered files contain an sk- key"
  if [ -n "$PY" ]; then
    # shellcheck disable=SC2016
    if out=$("$PY" -I -c '
import json, os, sys, tomllib
root = sys.argv[1]; n = bad = 0
for d, _, fs in os.walk(root):
    if os.sep + ".agents" + os.sep + "skills" in d + os.sep: continue
    for f in fs:
        p = os.path.join(d, f)
        try:
            if f.endswith(".json"): json.load(open(p, encoding="utf-8")); n += 1
            elif f.endswith(".toml"):
                cfg = tomllib.load(open(p, "rb")); n += 1
                if p.endswith(os.path.join(".cpa-tools", "cpa-tools.toml")):
                    assert cfg["app_dir"]
                    if os.environ.get("CPA_APP_DIR"): assert cfg["app_dir"] == os.environ["CPA_APP_DIR"]
        except Exception as e:
            bad += 1; print("    parse error:", os.path.relpath(p, root), type(e).__name__)
print(n, bad)
sys.exit(1 if bad else 0)' "$(wp "$D")"); then ok "configs parse ($(echo "$out" | tail -n 1 | cut -d' ' -f1) json/toml files)"
    else fail "config parse"; echo "$out"
    fi
  fi

  # Run scripts: render each one this machine would run (chezmoi cat), then parse it.
  mkdir -p "$S/scripts"
  nsc=0; nempty=0; bad=0
  "$CZ" managed "$@" --include=scripts --path-style=absolute > "$S/scripts.list" 2>/dev/null || fail "chezmoi managed --include=scripts"
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    t=$(printf '%s' "$t" | tr -d '\r')
    out="$S/scripts/$(basename "$t")"
    if "$CZ" cat "$@" "$t" > "$out" 2>"$S/cat.err"; then
      if [ -z "$(tr -d ' \t\r\n' < "$out")" ]; then nempty=$((nempty + 1)); rm -f "$out"; else nsc=$((nsc + 1)); fi
    else bad=$((bad + 1)); fail "render $(basename "$t"): $(head -n 1 "$S/cat.err")"; rm -f "$out"
    fi
  done < "$S/scripts.list"
  nsh=0; nps=0
  for f in "$S"/scripts/*; do
    [ -f "$f" ] || continue
    case "$f" in
      *.sh) nsh=$((nsh + 1)); sh -n "$f" 2>/dev/null || { bad=$((bad + 1)); fail "sh -n $(basename "$f")"; } ;;
      *.ps1) nps=$((nps + 1)) ;;
    esac
  done
  if [ "$nps" -gt 0 ] && [ -n "$PS" ]; then
    AE_PS_DIR=$(wp "$S/scripts") "$PS" -NoProfile -NonInteractive -Command '
      $bad = 0
      foreach ($f in (Get-ChildItem -File -Filter *.ps1 -LiteralPath $env:AE_PS_DIR)) {
        $t = $null; $e = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)
        if ($e.Count -gt 0) { $bad++; Write-Output ("  FAIL  parse " + $f.Name + ": " + $e[0].Message) }
        foreach ($b in [System.IO.File]::ReadAllBytes($f.FullName)) { if ($b -gt 127) { $bad++; Write-Output ("  FAIL  non-ASCII byte in " + $f.Name); break } }
      }
      if ($bad -gt 0) { exit 1 }' || { bad=$((bad + 1)); TOTAL_FAIL=$((TOTAL_FAIL + 1)); }
  elif [ "$nps" -gt 0 ]; then info "no PowerShell: $nps .ps1 scripts not parsed"
  fi
  [ "$bad" = 0 ] && ok "run scripts render and parse ($nsh sh, $nps ps1; $nempty skipped by their guard)"

  # Skill links, against the scratch destination only (the script writes under .chezmoi.destDir).
  case ",$hs," in
    *,claude,*)
      nskills=$(find "$D/.agents/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
      ls_s=$(find "$S/scripts" -type f -name '*20-skills-links*' | head -n 1)
      if [ -z "$ls_s" ]; then fail "skill-link script did not render"
      else
        for run in 1 2; do
          case "$ls_s" in
            *.ps1) "$PS" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wp "$ls_s")" > "$S/links$run.out" 2>&1 ;;
            *) sh "$ls_s" > "$S/links$run.out" 2>&1 ;;
          esac || fail "skill-link script run $run"
        done
        if [ "$OSF" = windows ]; then
          nl=$(powershell.exe -NoProfile -NonInteractive -Command "@(Get-ChildItem -Force -LiteralPath '$(wp "$D/.claude/skills")' | Where-Object { \$_.LinkType -eq 'Junction' }).Count" | tr -d '\r ')
        else
          nl=$(find "$D/.claude/skills" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')
        fi
        [ "$nl" = "$nskills" ] && ok "skill links: $nl of $nskills" || fail "skill links: $nl of $nskills"
        if grep -q " $nskills ok, 0 created, 0 replaced (backed up), 0 relinked, 0 pruned, 0 kept" "$S/links2.out" 2>/dev/null; then
          ok "second link run changed nothing"
        else fail "second link run: $(grep 'skills links:' "$S/links2.out" | tr -d '\r')"
        fi
        if [ -e "$S/backups" ] || grep -q 'backup:' "$S/links1.out" "$S/links2.out" 2>/dev/null; then
          fail "link script made a backup in a fresh destination"
        fi
      fi ;;
  esac

  # Render the real verify template against scratch configs, then prove the routing check
  # rejects a stale link path. Override homeDir so no installed config is consulted.
  case ",$hs," in
    *,claude,*)
      if [ -n "$PY" ]; then
        "$PY" -I -c 'import json,sys; json.dump({"chezmoi":{"homeDir":sys.argv[1]}},open(sys.argv[2],"w"))' "$(wp "$D")" "$(wp "$S/verify-home.json")"
        settings="$D/.claude/settings.json"
        cp "$settings" "$S/settings-original.json"
        # Templates use chezmoi.homeDir even with --destination. Assert the rendered command
        # first, then rebase only its path for the scratch-home verify check.
        real_home=$("$CZ" execute-template "$@" '{{ .chezmoi.homeDir }}' | tr -d '\r')
        if "$PY" -I -c '
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); s=json.loads(p.read_text())
real=sys.argv[2].replace(chr(92),"/").rstrip("/")
scratch=sys.argv[3].replace(chr(92),"/").rstrip("/")
want="node \""+real+"/.agents/skills/subagent-routing/scripts/routing-hook.mjs\""
found=[]
for g in s["hooks"]["PreToolUse"]:
    for h in g["hooks"]:
        if "routing-hook.mjs" in h.get("command", ""):
            assert g["matcher"]=="^(.*_)?(Agent|Workflow)$" and h["command"]==want
            found.append(h)
assert len(found)==1
found[0]["command"]=want.replace(real,scratch,1)
p.write_text(json.dumps(s),encoding="utf-8")' "$(wp "$settings")" "$real_home" "$(wp "$D")"; then
          ok "rendered routing hook uses the canonical path and matcher"
        else fail "rendered routing hook path or matcher"; fi
        if "$CZ" execute-template "$@" --override-data-file "$(wp "$S/verify-home.json")" --file "$(wp "$REPO/scripts/verify.d/30-harness.checks.tmpl")" > "$S/harness-checks" 2> "$S/harness-checks.err" &&
           grep -q '^OK claude: subagent-routing PreToolUse hook uses the canonical script' "$S/harness-checks"; then
          ok "routing hook uses the real canonical script and verify accepts it"
        else fail "routing hook verification against scratch configs"; fi
        "$PY" -I -c 'import sys; from pathlib import Path; p=Path(sys.argv[1]); p.write_text(p.read_text().replace(".agents/skills/subagent-routing/", ".claude/skills/subagent-routing/"),encoding="utf-8")' "$(wp "$settings")"
        if "$CZ" execute-template "$@" --override-data-file "$(wp "$S/verify-home.json")" --file "$(wp "$REPO/scripts/verify.d/30-harness.checks.tmpl")" > "$S/harness-checks" 2> "$S/harness-checks.err" &&
           grep -q '^FAIL claude: subagent-routing PreToolUse hook or canonical script missing' "$S/harness-checks"; then
          ok "verify rejects routing through the stale skill link"
        else fail "verify accepted stale routing hook"; fi
        cp "$S/settings-original.json" "$settings"
      fi ;;
  esac

  # Expected paths.
  exp="$REPO/tests/render/$name.paths"
  tree_paths "$D" > "$S/paths"
  if [ "$UPDATE" = 1 ]; then mkdir -p "$REPO/tests/render"; cp "$S/paths" "$exp"; info "wrote tests/render/$name.paths ($(wc -l < "$exp" | tr -d ' ') paths)"
  elif [ -f "$exp" ]; then
    if diff "$exp" "$S/paths" > "$S/paths.diff"; then ok "paths match tests/render/$name.paths ($(wc -l < "$exp" | tr -d ' '))"
    else fail "paths differ from tests/render/$name.paths"; sed -n '1,20p' "$S/paths.diff"; fi
  else info "no tests/render/$name.paths (run with --update to record it)"
  fi
done

printf '\n'
if [ -f "$TMP/op-called" ]; then fail "op was called $(wc -l < "$TMP/op-called" | tr -d ' ') times"; else ok "op was never called"; fi
if [ "$TOTAL_FAIL" -eq 0 ]; then echo "render-test: all passed"; else echo "render-test: $TOTAL_FAIL failures"; fi
[ "$TOTAL_FAIL" -eq 0 ]
