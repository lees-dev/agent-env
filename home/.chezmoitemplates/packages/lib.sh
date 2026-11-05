# shellcheck shell=sh
# Helpers for the packages run_ scripts (WSL, Linux, macOS). chezmoi pastes this file into
# each script with the template action for "packages/lib.sh". It must contain no template
# actions (not even in comments: they would run), so
# scripts/check.sh parses it as plain sh.
#
# Output: names, versions and counts only. Installer output goes to the terminal as the
# vendor prints it; none of these installers prints a credential.
# AGENT_ENV_DRY_RUN=1 prints what would change and changes nothing.

PK_CHANGED=0
PK_FAILED=0
PK_FAILED_NAMES=''

pk_say()  { printf 'packages: %s\n' "$*"; }
pk_fail() { PK_FAILED=$((PK_FAILED + 1)); PK_FAILED_NAMES="$PK_FAILED_NAMES $1"; printf 'packages: FAIL %s\n' "$*" >&2; }
pk_dry()  { [ "${AGENT_ENV_DRY_RUN:-0}" = 1 ]; }

# pk_finish <script name>: print the counts; exit 1 when anything failed.
pk_finish() {
  pk_say "$1: $PK_CHANGED changed, $PK_FAILED failed${PK_FAILED_NAMES:+ (}${PK_FAILED_NAMES# }${PK_FAILED_NAMES:+)}"
  [ "$PK_FAILED" -eq 0 ] || exit 1
}

# On WSL, Windows directories (/mnt/c/...) are on PATH. Never run a Windows binary from here:
# drop them for the rest of the script, so `npm`, `node` or `codex` cannot resolve to Windows.
pk_no_windows_path() {
  _pk_new=''
  _pk_ifs=$IFS; IFS=:
  for _pk_d in $PATH; do
    case "$_pk_d" in /mnt/[a-z]/*|'') continue ;; esac
    _pk_new="${_pk_new:+$_pk_new:}$_pk_d"
  done
  IFS=$_pk_ifs
  PATH=$_pk_new; export PATH
}

# pk_path_prepend <dir>: put dir first on PATH for this script (moving it if already there).
pk_path_prepend() {
  _pk_new=$1
  _pk_ifs=$IFS; IFS=:
  for _pk_d in $PATH; do
    [ "$_pk_d" = "$1" ] || [ -z "$_pk_d" ] || _pk_new="$_pk_new:$_pk_d"
  done
  IFS=$_pk_ifs
  PATH=$_pk_new; export PATH
}

# pk_semver <text>: the first x.y.z in text (empty when none).
pk_semver() {
  printf '%s\n' "$1" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

# pk_version <command> [args...]: semver of the command's output, or empty if it is missing/fails.
pk_version() {
  if [ -x "$1" ] || command -v "$1" >/dev/null 2>&1; then
    pk_semver "$("$@" 2>/dev/null </dev/null | head -n 5)"
  fi
}

# pk_cmp <a> <b>: prints lt, eq or gt (numeric x.y.z compare; empty a is lt).
pk_cmp() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    if (a == "") { print "lt"; exit }
    na = split(a, x, "."); nb = split(b, y, ".")
    n = (na > nb) ? na : nb
    for (i = 1; i <= n; i++) {
      if ((x[i] + 0) < (y[i] + 0)) { print "lt"; exit }
      if ((x[i] + 0) > (y[i] + 0)) { print "gt"; exit }
    }
    print "eq"
  }'
}

# pk_fetch <https-url> <dest>: download over HTTPS only, with retries and a timeout.
pk_fetch() {
  case "$1" in https://*) ;; *) echo "refusing non-https URL" >&2; return 1 ;; esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 600 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -T 60 -O "$2" "$1"
  else
    echo "neither curl nor wget is installed" >&2; return 1
  fi
}

# pk_tmpdir: a private scratch directory, removed when the script exits.
pk_tmpdir() {
  PK_TMP=$(mktemp -d 2>/dev/null || mktemp -d -t agent-env)
  trap 'rm -rf "$PK_TMP"' EXIT INT TERM
}

# pk_get_installer <name> <url>: fetch a vendor installer into PK_TMP and set PK_INSTALLER to
# its path. The caller runs it, for example: env GROK_BIN_DIR=... bash "$PK_INSTALLER" 1.0.70
# (installers run from a file, never piped, so a cut-off download cannot run half a script).
pk_get_installer() {
  [ -n "${PK_TMP:-}" ] || pk_tmpdir
  PK_INSTALLER="$PK_TMP/$1-install"
  pk_fetch "$2" "$PK_INSTALLER"
}
