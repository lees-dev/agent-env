# shellcheck shell=sh
# Source, then call ae_load_cpa_dir. The local environment file holds one raw absolute path.
ae_load_cpa_dir() {
  [ -z "${CPA_APP_DIR:-}" ] || return 0
  _ae_cpa_file="$HOME/.config/agent-env/cpa-app-dir"
  if [ -e "$_ae_cpa_file" ] || [ -L "$_ae_cpa_file" ]; then
    _ae_cpa_stat=$(stat -c '%a:%u' "$_ae_cpa_file" 2>/dev/null) ||
      _ae_cpa_stat=$(stat -f '%Lp:%u' "$_ae_cpa_file" 2>/dev/null) || return 1
    if [ -L "$_ae_cpa_file" ] || [ ! -f "$_ae_cpa_file" ] ||
       [ "$_ae_cpa_stat" != "600:$(id -u)" ]; then
      printf '%s\n' 'CPA path environment file must be a regular, user-owned mode-0600 file' >&2
      unset _ae_cpa_file _ae_cpa_stat
      return 1
    fi
    CPA_APP_DIR=$(cat "$_ae_cpa_file") || return 1
    export CPA_APP_DIR
  fi
  unset _ae_cpa_file _ae_cpa_stat
}
