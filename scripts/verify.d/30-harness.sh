# shellcheck shell=sh
# verify drop-in (harness): every chosen harness points at the hub, gets its key from the cpa
# token helper, carries no plaintext key, and has its hook, plugins and MCP servers.
# The checks live in 30-harness.checks.tmpl, shared with 30-harness.ps1: chezmoi renders it
# with this machine's data and each output line becomes one check. Read-only; sourced by
# scripts/verify, so it never exits.

_ae_h_tmpl="$REPO/scripts/verify.d/30-harness.checks.tmpl"
if ! _ae_h_out=$(chezmoi execute-template < "$_ae_h_tmpl" 2>/dev/null); then
  _ae_h_out='FAIL harness checks could not run: a harness config does not parse as JSON/TOML
HINT run scripts/preflight, which names the file'
fi
while IFS= read -r _ae_h_line; do
  case "$_ae_h_line" in
    "OK "*)   ae_ok "${_ae_h_line#OK }" ;;
    "WARN "*) ae_warn "${_ae_h_line#WARN }" ;;
    "FAIL "*) ae_fail "${_ae_h_line#FAIL }" ;;
    "HINT "*) ae_hint "${_ae_h_line#HINT }" ;;
    "INFO "*) ae_info "${_ae_h_line#INFO }" ;;
  esac
done <<EOF
$_ae_h_out
EOF
unset _ae_h_tmpl _ae_h_out _ae_h_line
