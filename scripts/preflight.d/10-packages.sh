# shellcheck shell=sh
# packages preflight (WSL, Linux, macOS). Sourced by scripts/preflight: read-only, never exits.
# Uses REPO VERSIONS ROLE MACHINE OS and the ae_* helpers from scripts/lib/common.sh.

_pk_harn=${AGENT_ENV_HARNESSES:-$(ae_chezmoi_data harnesses | tr -d '[]' | tr ' ' ',')}
[ -n "$_pk_harn" ] || _pk_harn=claude,codex,grok,muse
_pk_optin=${AGENT_ENV_SYSTEM_PACKAGES:-0}

# Installer prerequisites. mise.run and the Grok/Claude/Muse installers need curl (or wget),
# bash, tar and gzip; the CodeRabbit installer needs unzip.
if ae_have curl || ae_have wget; then ae_ok "downloader: $(ae_have curl && echo curl || echo wget)"
else ae_fail "neither curl nor wget is installed: no installer can run"; fi
for _pk_t in bash tar gzip unzip; do
  if ae_have "$_pk_t"; then ae_ok "$_pk_t present"
  else
    ae_fail "$_pk_t is not installed (the vendor installers need it)"
    if [ "$ROLE" = server ]; then ae_hint "server role: ask the machine's owner to install it (this repo never uses sudo there)"
    else ae_hint "listed in packages/apt.txt / dnf.txt: apply with AGENT_ENV_SYSTEM_PACKAGES=1 after 'sudo -v'"; fi
  fi
done

# The WSL/Windows boundary: Windows binaries on PATH are dropped inside the install scripts.
if [ "$OS" = wsl ]; then
  _pk_n=0
  for _pk_t in node npm npx codex claude uv gh; do
    _pk_p=$(command -v "$_pk_t" 2>/dev/null || true)
    case "$_pk_p" in /mnt/[a-z]/*) _pk_n=$((_pk_n + 1)); ae_warn "$_pk_t resolves to a Windows binary ($_pk_p)" ;; esac
  done
  [ "$_pk_n" -gt 0 ] || ae_ok "no tool resolves to a Windows binary under /mnt"
  [ "$_pk_n" -eq 0 ] || ae_hint "the install scripts drop /mnt/* from PATH; env.d/10-packages.sh puts the Linux copies first"
fi

# System packages: report only.
case "$OS" in
  macos) _pk_list='' ;;
  *) if ae_have dpkg-query; then _pk_list="$REPO/packages/apt.txt"
     elif ae_have rpm; then _pk_list="$REPO/packages/dnf.txt"
     else _pk_list=''; fi ;;
esac
if [ -n "$_pk_list" ]; then
  _pk_miss=''
  for _pk_p in $(sed 's/#.*//' "$_pk_list"); do
    if ae_have dpkg-query; then
      dpkg-query -W -f='${Status}' "$_pk_p" 2>/dev/null | grep -q 'install ok installed' || _pk_miss="$_pk_miss $_pk_p"
    else
      rpm -q "$_pk_p" >/dev/null 2>&1 || _pk_miss="$_pk_miss $_pk_p"
    fi
  done
  if [ -z "$_pk_miss" ]; then ae_ok "system packages in $(basename "$_pk_list") all present"
  elif [ "$ROLE" = server ]; then ae_warn "system packages missing:$_pk_miss (server role: never installed by this repo)"
  else
    ae_warn "system packages missing:$_pk_miss"
    if [ "$_pk_optin" = 1 ]; then
      if [ "$(id -u)" -eq 0 ] || sudo -n true 2>/dev/null; then ae_ok "sudo works without a prompt (opt-in is on)"
      else ae_fail "AGENT_ENV_SYSTEM_PACKAGES=1 but sudo needs a password"; ae_hint "run 'sudo -v' right before chezmoi apply"; fi
    else
      ae_hint "they are installed only with the owner's OK: AGENT_ENV_SYSTEM_PACKAGES=1 chezmoi apply ..."
    fi
  fi
elif [ "$OS" = macos ]; then
  if ae_have brew; then ae_ok "Homebrew present"
  else ae_warn "Homebrew not installed: the Brewfile is skipped"; ae_hint "install it from https://brew.sh, then apply again"; fi
fi

# mise (user-level; installed by run_onchange_before_12 when missing or off the pin).
_pk_pin=$(ae_pin "$VERSIONS" tools mise "$MACHINE")
_pk_have=''
[ -x "$HOME/.local/bin/mise" ] && _pk_have=$(ae_semver "$("$HOME/.local/bin/mise" --version 2>/dev/null)")
if [ "$_pk_have" = "$_pk_pin" ]; then ae_ok "mise $_pk_have at ~/.local/bin/mise"
else ae_warn "mise ${_pk_have:-not installed} at ~/.local/bin/mise (pin $_pk_pin): apply installs it"; fi

# What currently wins on PATH for the harnesses (apply puts the user-level copies first).
case ",$_pk_harn," in *,claude,*)
  _pk_p=$(command -v claude 2>/dev/null || true)
  if [ -n "$_pk_p" ] && [ "$_pk_p" != "$HOME/.local/bin/claude" ]; then
    ae_warn "claude resolves to $_pk_p, not ~/.local/bin/claude"
    ae_hint "after apply, new shells put ~/.local/bin first (env.d/10-packages.sh); remove the old copy when convenient"
  fi ;;
esac

# Machine-local version overrides (never in git).
if [ -f "$HOME/.config/agent-env/versions.local.toml" ]; then
  ae_info "machine-local overrides in ~/.config/agent-env/versions.local.toml are in effect"
fi
_pk_o=$(ae_toml_get "$VERSIONS" "overrides.$MACHINE" uv)
[ -z "$_pk_o" ] || ae_info "versions.toml pins uv $_pk_o on $MACHINE"

# The vendor download hosts answer (status codes only).
if ae_have curl; then
  _pk_bad=''
  for _pk_u in https://mise.run https://claude.ai/install.sh https://x.ai/cli/stable \
               https://dev.meta.ai/install.sh https://cli.coderabbit.ai/install.sh https://github.com; do
    _pk_c=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 10 "$_pk_u" 2>/dev/null || true)
    case "$_pk_c" in 2*|3*) ;; *) _pk_bad="$_pk_bad ${_pk_u#https://}($_pk_c)" ;; esac
  done
  if [ -z "$_pk_bad" ]; then ae_ok "vendor download hosts reachable"
  else ae_warn "unreachable:$_pk_bad"; fi
fi
unset _pk_harn _pk_optin _pk_t _pk_n _pk_p _pk_list _pk_miss _pk_pin _pk_have _pk_o _pk_bad _pk_u _pk_c

# Tools stage is independent of op and the hub; missing tools here are warnings.
for _pk_t in pnpm bun rg mvn java javac higgsfield vercel coderabbit; do
  if ae_have "$_pk_t"; then ae_ok "$_pk_t present"
  else ae_warn "$_pk_t missing: run sh scripts/install-tools before provisioning"; fi
done
if [ "$ROLE" != server ] && [ "$OS" != wsl ]; then
  for _pk_t in t3code jetbrains-toolbox; do
    if ae_have "$_pk_t"; then ae_ok "$_pk_t installed"
    elif [ "$_pk_t" = jetbrains-toolbox ]; then ae_warn "$_pk_t missing: the tools stage needs AGENT_ENV_SYSTEM_PACKAGES=1 to install it"
    else ae_warn "$_pk_t missing: the tools stage installs it"; fi
  done
fi
