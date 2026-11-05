# shellcheck shell=sh
# Shared helpers for scripts/preflight, scripts/verify, scripts/backup and their .d/ drop-ins.
# POSIX sh only (dash, bash, zsh and busybox ash must all run it). Source it; do not run it.
#
# Output rules: print check names, statuses and counts. Never print a secret, an account
# email, a file's contents or a log line. Commands that might print one go to /dev/null.

AE_OK=0
AE_WARN=0
AE_FAIL=0

ae_ok()   { AE_OK=$((AE_OK + 1));     printf '  OK    %s\n' "$*"; }
ae_warn() { AE_WARN=$((AE_WARN + 1)); printf '  WARN  %s\n' "$*"; }
ae_fail() { AE_FAIL=$((AE_FAIL + 1)); printf '  FAIL  %s\n' "$*"; }
ae_info() { printf '  INFO  %s\n' "$*"; }
ae_hint() { printf '        -> %s\n' "$*"; }
ae_section() { printf '\n== %s\n' "$*"; }

ae_have() { command -v "$1" >/dev/null 2>&1; }

# ae_summary <name>: print the counts and return 1 when any check failed.
ae_summary() {
  printf '\n%s: %d ok, %d warn, %d fail\n' "$1" "$AE_OK" "$AE_WARN" "$AE_FAIL"
  [ "$AE_FAIL" -eq 0 ]
}

# Repo root: the directory above scripts/.
ae_repo_root() {
  CDPATH='' cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd -P
}

# ae_toml_get <file> <section> <key>: read `key = "value"` from [section] in versions.toml.
# Only the flat format documented at the top of versions.toml is supported.
ae_toml_get() {
  awk -v want="[$2]" -v key="$3" '
    /^[[:space:]]*\[/ { cur = $0; gsub(/[[:space:]]/, "", cur); next }
    cur == want {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (index(line, key " =") == 1 || index(line, key "=") == 1) {
        sub(/^[^=]*=[[:space:]]*"/, "", line); sub(/".*$/, "", line); print line; exit
      }
    }' "$1"
}

# ae_pin <versions.toml> <area> <name> [machine]: the pinned version of <area>.<name>, or the
# [overrides.<machine>] value for <name> when that machine has one.
ae_pin() {
  # ~/.config/agent-env/versions.local.toml [overrides] wins, as in packages/pins.json.
  _ae_lf="$HOME/.config/agent-env/versions.local.toml"
  if [ -f "$_ae_lf" ]; then
    _ae_o=$(ae_toml_get "$_ae_lf" overrides "$3")
    if [ -n "$_ae_o" ]; then echo "$_ae_o"; return 0; fi
  fi
  if [ -n "${4:-}" ]; then
    _ae_o=$(ae_toml_get "$1" "overrides.$4" "$3")
    if [ -n "$_ae_o" ]; then echo "$_ae_o"; return 0; fi
  fi
  ae_toml_get "$1" "$2.$3" version
}

# ae_semver <text>: first x.y.z in text.
ae_semver() {
  printf '%s\n' "$1" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

# ae_os_flavour: windows-shell | wsl | linux | macos (same names as the chezmoi data key osFlavour).
ae_os_flavour() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo macos ;;
    Linux)
      if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then echo wsl; else echo linux; fi ;;
    MINGW*|MSYS*|CYGWIN*) echo windows-shell ;;
    *) echo unknown ;;
  esac
}

# ae_sha256 <file>: hex digest on Linux (sha256sum) and macOS (shasum).
ae_sha256() {
  if ae_have sha256sum; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ae_chezmoi_data <key>: a chezmoi data value once `chezmoi init` has run, else empty.
# Keys are plain identifiers (same rule as the PowerShell helper).
ae_chezmoi_data() {
  ae_have chezmoi || return 0
  case "$1" in *[!A-Za-z0-9_]*|[!A-Za-z]*) return 0 ;; esac
  chezmoi execute-template "{{ .$1 }}" 2>/dev/null | sed 's/^<no value>$//'
}

# ae_run_dropins <dir> <label>: source every *.sh in dir, in name order, sharing the counters.
ae_run_dropins() {
  for _ae_f in "$1"/*.sh; do
    [ -f "$_ae_f" ] || continue
    ae_section "$2: $(basename "$_ae_f" .sh)"
    # shellcheck disable=SC1090
    . "$_ae_f"
  done
}
