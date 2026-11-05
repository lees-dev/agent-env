# shellcheck shell=sh
# cpa preflight (read-only), sourced by scripts/preflight. WSL, Linux, macOS.
#
# Checks: the management API is not reachable through the hub URL; the route for WSL on the
# hub host; plaintext
# key files left by the old wiring (counted, never read). Sends no key. Never exits.
# Variables from scripts/preflight: REPO VERSIONS ROLE MACHINE OS VAULT CPA_URL.

_cpa_code() { # _cpa_code <url> [timeout]: HTTP status of an unauthenticated GET; 000 when unreachable
  _cpa_c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "${2:-8}" "$1" 2>/dev/null) || true
  printf '%s' "${_cpa_c:-000}"
}

if ! ae_have curl; then
  ae_info "curl not found: cpa checks skipped (the base checks FAIL it)"
else
  # 1. The serve URL must mount /v1 only. Requests through tailscale serve reach CPA from
  #    127.0.0.1, so CPA's allow-remote=false would not stop them: only the mount does.
  case "$CPA_URL" in
    https://*)
      _cpa_m=$(_cpa_code "$CPA_URL/v8/management/config")
      case "$_cpa_m" in
        404) ae_ok "management API not served at $CPA_URL (HTTP 404)" ;;
        000) ae_info "management exposure not checked: hub unreachable" ;;
        *) ae_fail "management API answers through $CPA_URL (HTTP $_cpa_m): serve must mount /v1 only"
           ae_hint "on the hub: docs/cpa.md 'Tailscale serve'" ;;
      esac ;;
  esac

  # 2. WSL on the hub host cannot reach the hub's own serve URL (TCP 443 is refused), but
  #    mirrored networking shares the hub's loopback.
  if [ "$OS" = wsl ]; then
    _cpa_h=$(_cpa_code "$CPA_URL/v1/models")
    _cpa_l=$(_cpa_code "http://127.0.0.1:8317/v1/models" 4)
    if [ "$_cpa_h" = 000 ] && [ "$_cpa_l" != 000 ]; then
      ae_info "this WSL runs on the hub host: the hub answers on 127.0.0.1:8317 (HTTP $_cpa_l), not on $CPA_URL"
      ae_hint "docs/cpa.md 'WSL on the hub host' (use the loopback route; mint a key for remark '$MACHINE')"
    fi
  fi

fi

# 3. Optional private inventory: literal paths relative to home, one per line; never opened.
_cpa_inventory="$REPO/.tools/legacy-cpa-paths.list"
if [ -f "$_cpa_inventory" ]; then
  _cpa_n=0
  while IFS= read -r _cpa_f || [ -n "$_cpa_f" ]; do
    case "$_cpa_f" in ''|'#'*) continue ;; esac
    [ ! -f "$HOME/$_cpa_f" ] || _cpa_n=$((_cpa_n + 1))
  done < "$_cpa_inventory"
  if [ "$_cpa_n" -eq 0 ]; then ae_ok "no legacy credential files from the private inventory"
  else ae_warn "$_cpa_n legacy credential files remain; consult the owner's private inventory"; fi
else
  ae_info "legacy credential scan skipped: no local private inventory"
fi
unset _cpa_c _cpa_m _cpa_h _cpa_l _cpa_n _cpa_f _cpa_inventory
