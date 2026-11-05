# shellcheck shell=sh
# Source this file, then call ae_load_token service|account. No output contains a token.
ae_load_token() {
  [ "$1" = service ] || return 0
  [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || return 0
  _ae_token_file="$HOME/.config/op/agent-env-token"
  if [ -e "$_ae_token_file" ] || [ -L "$_ae_token_file" ]; then
    # Reject symlinks and anything except a regular file owned by this uid with mode 0600.
    _ae_token_stat=$(stat -c '%a:%u' "$_ae_token_file" 2>/dev/null) ||
      _ae_token_stat=$(stat -f '%Lp:%u' "$_ae_token_file" 2>/dev/null) || return 1
    if [ -L "$_ae_token_file" ] || [ ! -f "$_ae_token_file" ] ||
       [ "$_ae_token_stat" != "600:$(id -u)" ]; then
      printf '%s\n' 'service token file must be a regular, user-owned mode-0600 file' >&2
      unset _ae_token_file _ae_token_stat
      return 1
    fi
    OP_SERVICE_ACCOUNT_TOKEN=$(cat "$_ae_token_file") || return 1
    export OP_SERVICE_ACCOUNT_TOKEN
  fi
  unset _ae_token_file _ae_token_stat
}
