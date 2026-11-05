# shellcheck shell=sh
# cpa verify (read-only), sourced by scripts/verify. WSL, Linux, macOS.
#
# 1. The deployed key file (~/.config/agent-env/cpa-key, 0600) and the token helper (cpa-token).
# 2. The key read from 1Password at run time (op read) matches what the helper prints.
# 3. An authenticated GET <cpaUrl>/v1/models with the 1Password key: HTTP status and model count.
# 4. Per selected harness: the same GET at the base URL that harness uses, with the token its
#    helper prints: HTTP status and how many of the hub's models belong to that harness.
# The key lives only in shell variables and in curl's stdin (never argv, never a file, never
# printed). Never exits. Variables: REPO VERSIONS ROLE MACHINE OS HARNESSES.

_cpa_url=$(ae_chezmoi_data cpaUrl)
_cpa_vault=$(ae_chezmoi_data opVault)
_cpa_item=$(ae_chezmoi_data opCpaItem)
_cpa_anth=$(ae_chezmoi_data cpaAnthropicBaseUrl)
_cpa_oai=$(ae_chezmoi_data cpaOpenAIBaseUrl)
_cpa_keyf="$HOME/.config/agent-env/cpa-key"
_cpa_helper="$HOME/.config/agent-env/cpa-token"
_cpa_body=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/agent-env-cpa.$$")

# _cpa_get <url> <token>: sets _cpa_status (000 when unreachable) and leaves the body in $_cpa_body.
_cpa_get() {
  : > "$_cpa_body"
  if [ -n "$2" ]; then
    _cpa_status=$(printf 'Authorization: Bearer %s\n' "$2" |
      curl -sS -H @- -o "$_cpa_body" -w '%{http_code}' --max-time 20 "$1" 2>/dev/null) || true
  else
    _cpa_status=$(curl -sS -o "$_cpa_body" -w '%{http_code}' --max-time 20 "$1" 2>/dev/null) || true
  fi
  [ -n "$_cpa_status" ] || _cpa_status=000
}
# _cpa_ids: the model ids in $_cpa_body (OpenAI list shape: {"data":[{"id":...},...]}), one per line.
_cpa_ids() {
  grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$_cpa_body" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'
}
# _cpa_family <harness>: the model-id pattern that harness uses on the hub.
_cpa_family() {
  case "$1" in
    claude) echo '^claude' ;;
    codex) echo '^(gpt|codex|o[0-9])' ;;
    grok) echo '^grok' ;;
    muse) echo '^muse' ;;
    *) echo '^$' ;;
  esac
}

if [ -z "$_cpa_url" ] || [ -z "$_cpa_item" ]; then
  ae_fail "cpaUrl/opCpaItem not in chezmoi data: re-run chezmoi init (AGENTS.md step 3)"
elif ! ae_have curl; then
  ae_fail "curl not found: cannot probe the hub"
else
  # 1. Deployed key file and helper.
  if [ -s "$_cpa_keyf" ]; then
    _cpa_mode=$(ls -ln "$_cpa_keyf" 2>/dev/null | cut -c1-10)
    case "$_cpa_mode" in
      -rw-------) ae_ok "key file ~/.config/agent-env/cpa-key present (0600)" ;;
      *) case "$_cpa_keyf" in
           /mnt/*) ae_warn "key file mode is $_cpa_mode (DrvFs ignores chmod)" ;;
           *) ae_fail "key file mode is $_cpa_mode, want -rw------- (private_)" ;;
         esac ;;
    esac
  else
    ae_fail "key file ~/.config/agent-env/cpa-key missing or empty"; ae_hint "scripts/backup && chezmoi apply --force --no-tty"
  fi
  _cpa_tok=''
  if [ -x "$_cpa_helper" ]; then
    _cpa_tok=$("$_cpa_helper" 2>/dev/null) || _cpa_tok=''
    if [ -n "$_cpa_tok" ]; then ae_ok "helper ~/.config/agent-env/cpa-token prints a token (${#_cpa_tok} chars)"
    else ae_fail "helper ~/.config/agent-env/cpa-token printed nothing"; fi
  else
    ae_fail "helper ~/.config/agent-env/cpa-token missing or not executable"
  fi

  # 2-3. The 1Password key, read now.
  _cpa_key=''
  if [ "$(ae_chezmoi_data opMode)" = service ] && [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
    ae_fail "service token missing; owner must persist a user-owned mode-0600 token file (docs/cpa.md), then rerun"
  elif ae_have op; then
    _cpa_key=$(op read "op://$_cpa_vault/$_cpa_item/credential" </dev/null 2>/dev/null) || _cpa_key=''
  fi
  if [ -z "$_cpa_key" ]; then
    ae_fail "cannot read op://$_cpa_vault/$_cpa_item/credential now (op missing, not signed in, or no item)"
    ae_hint "sign in (preflight prints how), or mint the key on the hub (docs/cpa.md)"
  else
    if [ -n "$_cpa_tok" ] && [ "$_cpa_tok" = "$_cpa_key" ]; then ae_ok "deployed key matches 1Password item $_cpa_item"
    elif [ -n "$_cpa_tok" ]; then ae_fail "deployed key differs from 1Password item $_cpa_item"; ae_hint "scripts/backup && chezmoi apply --force --no-tty"
    fi
    _cpa_get "$_cpa_url/v1/models" "$_cpa_key"
    _cpa_n=$(_cpa_ids | wc -l | tr -d ' ')
    case "$_cpa_status" in
      200) if [ "$_cpa_n" -gt 0 ]; then ae_ok "hub $_cpa_url/v1/models with the 1Password key: HTTP 200, $_cpa_n models"
           else ae_fail "hub $_cpa_url/v1/models: HTTP 200 but no models listed"; fi ;;
      401|403) ae_fail "hub rejected the key for $_cpa_item (HTTP $_cpa_status): not registered, or revoked"
               ae_hint "on the hub: py -I ~/.cpa-tools/list_client_keys.py, then docs/cpa.md 'Mint a key'" ;;
      000) ae_fail "hub $_cpa_url unreachable"; ae_hint "tailscale status; the tailnet grant; is Beast on?" ;;
      *) ae_fail "hub $_cpa_url/v1/models: HTTP $_cpa_status" ;;
    esac
  fi

  # 4. Per harness, with the token the harness's helper gives it.
  for _cpa_h in $HARNESSES; do
    case "$_cpa_h" in claude) _cpa_base=$_cpa_anth; _cpa_path=/v1/models ;; *) _cpa_base=$_cpa_oai; _cpa_path=/models ;; esac
    if [ -z "$_cpa_tok" ]; then ae_fail "$_cpa_h: no token from the helper, hub not probed"; continue; fi
    _cpa_get "$_cpa_base$_cpa_path" "$_cpa_tok"
    _cpa_f=$(_cpa_ids | grep -Ec "$(_cpa_family "$_cpa_h")") || true
    case "$_cpa_status" in
      200) if [ "${_cpa_f:-0}" -gt 0 ]; then ae_ok "$_cpa_h: $_cpa_base$_cpa_path HTTP 200, $_cpa_f $_cpa_h models"
           else ae_warn "$_cpa_h: $_cpa_base$_cpa_path HTTP 200, but no $_cpa_h models on the hub"; fi ;;
      *) ae_fail "$_cpa_h: $_cpa_base$_cpa_path HTTP $_cpa_status with the helper's token" ;;
    esac
  done

fi
rm -f "$_cpa_body"
unset _cpa_key _cpa_tok _cpa_url _cpa_vault _cpa_item _cpa_anth _cpa_oai _cpa_keyf _cpa_helper \
  _cpa_body _cpa_status _cpa_mode _cpa_n _cpa_h _cpa_base _cpa_path _cpa_f
