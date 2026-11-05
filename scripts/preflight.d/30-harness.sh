# shellcheck shell=sh
# preflight drop-in (harness): read-only checks that the harness modify_ templates can merge.
#   - the repo's harness settings (home/.chezmoitemplates/harness/config.toml) parse
#   - each harness config that already exists parses as JSON or TOML. A file that does not
#     parse would stop `chezmoi apply`: the modify_ templates never overwrite what they
#     cannot read. FAIL names the file only.
#   - node is on PATH (the pr-workflow hook runs under node)
#   - which inline credential keys the apply will remove (key names only, never values)
# Sourced by scripts/preflight; never exits.

if ! ae_have chezmoi; then
  ae_warn "harness: chezmoi not installed yet, so the config parse checks are skipped"
else
  # Templates go in on stdin (same as the PowerShell drop-in, where arguments lose quotes).
  if _ae_h_n=$(printf '%s' '{{ includeTemplate "harness/config.toml" . | fromToml | len }}' |
      chezmoi --source "$REPO" execute-template 2>/dev/null) && [ "${_ae_h_n:-0}" -gt 0 ]; then
    ae_ok "harness: repo settings parse ($_ae_h_n tables)"
  else
    ae_fail "harness: home/.chezmoitemplates/harness/config.toml does not parse"
  fi
  for _ae_h_f in .claude/settings.json:fromJson .config/muse/settings.json:fromJson \
                 .t3/userdata/settings.json:fromJson .codex/config.toml:fromToml \
                 .grok/config.toml:fromToml; do
    _ae_h_path="$HOME/${_ae_h_f%%:*}"
    _ae_h_fn=${_ae_h_f##*:}
    [ -f "$_ae_h_path" ] || continue
    # Git Bash: chezmoi.exe needs a Windows path, not /c/Users/...
    if [ "${OS:-}" = windows-shell ] && ae_have cygpath; then _ae_h_path=$(cygpath -m "$_ae_h_path"); fi
    if printf '{{ $_ := include `%s` | %s }}ok' "$_ae_h_path" "$_ae_h_fn" |
        chezmoi execute-template >/dev/null 2>&1; then
      ae_ok "harness: ~/${_ae_h_f%%:*} parses"
    else
      ae_fail "harness: ~/${_ae_h_f%%:*} does not parse; fix it before apply (the merge never overwrites it)"
    fi
  done
fi

if ae_have node; then ae_ok "harness: node on PATH (pr-workflow hook)"
else ae_warn "harness: node not on PATH; the pr-workflow hook needs it (the packages step installs it)"; fi

# Inline credentials the apply replaces with the cpa token helper. Key names only.
_ae_h_n=0
if [ -f "$HOME/.claude/settings.json" ] && grep -q '"ANTHROPIC_AUTH_TOKEN"' "$HOME/.claude/settings.json"; then _ae_h_n=$((_ae_h_n + 1)); fi
if [ -f "$HOME/.codex/config.toml" ] && grep -q 'experimental_bearer_token' "$HOME/.codex/config.toml"; then _ae_h_n=$((_ae_h_n + 1)); fi
if [ "$_ae_h_n" -gt 0 ]; then
  ae_info "harness: $_ae_h_n harness config(s) hold an inline key; apply removes it and points them at the cpa token helper"
fi
unset _ae_h_n _ae_h_f _ae_h_path _ae_h_fn
