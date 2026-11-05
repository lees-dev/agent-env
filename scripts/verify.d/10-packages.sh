# shellcheck shell=sh
# packages verify (WSL, Linux, macOS). Sourced by scripts/verify: read-only, never exits.
# Uses REPO VERSIONS ROLE MACHINE OS HARNESSES and the ae_* helpers from scripts/lib/common.sh.
#
# It first sources ~/.config/agent-env/env.sh, so the checks see PATH the way a new shell
# will, even when the agent's own shell started before the apply.

_pk_local="$HOME/.config/agent-env/versions.local.toml"
_pk_pin() { # _pk_pin <area> <name>: machine-local override > versions.toml override > pin
  if [ -f "$_pk_local" ]; then
    _pk_v=$(ae_toml_get "$_pk_local" overrides "$2")
    if [ -n "$_pk_v" ]; then echo "$_pk_v"; return 0; fi
  fi
  if [ "$1" = skills ]; then
    _pk_v=$(ae_toml_get "$VERSIONS" "overrides.$MACHINE" "$2")
    if [ -n "$_pk_v" ]; then echo "$_pk_v"; else ae_toml_get "$VERSIONS" "$1.$2" cli_version; fi
  else ae_pin "$VERSIONS" "$1" "$2" "$MACHINE"; fi
}
_pk_harness() { case " $HARNESSES " in *" $1 "*) return 0 ;; esac; return 1; }

# PATH wiring.
if [ -r "$HOME/.config/agent-env/env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/agent-env/env.sh"
  ae_ok "env.sh deployed and sourced"
else
  ae_fail '~'"/.config/agent-env/env.sh is missing"; ae_hint "chezmoi apply deploys it"
fi
_pk_hooked=0
for _pk_f in .bashrc .zshrc .bash_profile .bash_login .profile; do
  [ -f "$HOME/$_pk_f" ] && grep -qF '# >>> agent-env >>>' "$HOME/$_pk_f" && _pk_hooked=$((_pk_hooked + 1))
done
if [ "$_pk_hooked" -gt 0 ]; then ae_ok "agent-env block in $_pk_hooked shell startup file(s)"
else ae_fail "no shell startup file sources env.sh"; ae_hint "run_onchange_before_10-packages-path adds it on apply"; fi

# _pk_check <cmd> <want-path-prefix|-> <version> <fail|warn> [version args...]
_pk_check() {
  _pk_cmd=$1; _pk_where=$2; _pk_want=$3; _pk_sev=$4; shift 4
  if [ "$_pk_want" = skip ]; then ae_info "$_pk_cmd skipped on this machine"; return 0; fi
  _pk_p=$(command -v "$_pk_cmd" 2>/dev/null || true)
  if [ -z "$_pk_p" ]; then "ae_$_pk_sev" "$_pk_cmd not on PATH (pin $_pk_want)"; return 0; fi
  case "$_pk_p" in /mnt/[a-z]/*) ae_fail "$_pk_cmd resolves to a Windows binary ($_pk_p)"; return 0 ;; esac
  _pk_h=$(ae_semver "$("$_pk_p" "$@" 2>/dev/null </dev/null | head -n 5)")
  if [ "$_pk_where" != - ]; then
    case "$_pk_p" in "$_pk_where"*) ;; *) ae_warn "$_pk_cmd resolves to $_pk_p, expected under $_pk_where" ;; esac
  fi
  case "$_pk_want" in
    skip) ae_info "$_pk_cmd $_pk_h (skipped on this machine)" ;;
    "$_pk_h"|"$_pk_h".*) ae_ok "$_pk_cmd $_pk_h" ;;
    *) case "$_pk_h" in "$_pk_want".*) ae_ok "$_pk_cmd $_pk_h" ;; *) "ae_$_pk_sev" "$_pk_cmd ${_pk_h:-unknown}, pin $_pk_want" ;; esac ;;
  esac
}

_pk_shims="${XDG_DATA_HOME:-$HOME/.local/share}/mise/shims"
_pk_check mise "$HOME/.local/bin/" "$(_pk_pin tools mise)" fail --version
if [ -f "$HOME/.config/mise/conf.d/agent-env.toml" ]; then ae_ok "mise pins deployed (~/.config/mise/conf.d/agent-env.toml)"
else ae_fail '~'"/.config/mise/conf.d/agent-env.toml is missing"; fi
# mise loads conf.d before config.toml, so the owner's own pins win (docs/packages.md "mise pins").
# Names the shadowed tools only; never prints a value.
_pk_tools() { # _pk_tools <file>: the keys of its [tools] table, one per line
  [ -f "$1" ] || return 0
  awk '/^[[:space:]]*\[/ { t = ($0 ~ /^[[:space:]]*\[tools\][[:space:]]*$/); next }
       t && /=/ { k = $0; sub(/=.*/, "", k); gsub(/[[:space:]"\047]/, "", k); if (k != "" && k !~ /^#/) print k }' "$1"
}
_pk_ours=$(_pk_tools "$HOME/.config/mise/conf.d/agent-env.toml")
_pk_shadow=''
for _pk_f in config.toml config.local.toml; do
  for _pk_k in $(_pk_tools "$HOME/.config/mise/$_pk_f"); do
    case " $(echo $_pk_ours) " in *" $_pk_k "*) _pk_shadow="$_pk_shadow $_pk_k (~/.config/mise/$_pk_f)" ;; esac
  done
done
if [ -n "$_pk_shadow" ]; then
  ae_warn "your own mise config pins tools agent-env pins, and wins:$_pk_shadow"
  ae_hint "remove those lines yourself (agent-env never edits them), or the version checks below fail"
fi
unset -f _pk_tools 2>/dev/null || true
unset _pk_ours _pk_shadow _pk_k
_pk_check node "$_pk_shims/" "$(_pk_pin tools node)" fail --version
_pk_check uv "$_pk_shims/" "$(_pk_pin tools uv)" fail --version
_pk_check gh "$_pk_shims/" "$(_pk_pin tools gh)" fail --version
_pk_check oh-my-posh "$_pk_shims/" "$(_pk_pin tools oh-my-posh)" fail version
_pk_check coderabbit "$HOME/.local/bin/" "$(_pk_pin tools coderabbit)" fail --version
for _pk_py in "$(ae_toml_get "$VERSIONS" tools.python minor)" "$(ae_toml_get "$VERSIONS" tools.python312 minor)"; do
  _pk_check "python$_pk_py" "$HOME/.local/bin/" "$_pk_py" fail --version
done

for _pk_t in pnpm bun; do _pk_check "$_pk_t" "$HOME/.local/bin/" "$(_pk_pin tools "$_pk_t")" fail --version; done
_pk_check rg "$_pk_shims/" "$(_pk_pin tools ripgrep)" fail --version
_pk_check mvn "$_pk_shims/" "$(_pk_pin tools maven)" fail --version
_pk_check java "$_pk_shims/" "$(_pk_pin tools java)" fail --version
_pk_check javac "$_pk_shims/" "$(_pk_pin tools java)" fail --version
if [ "$(_pk_pin tools java)" = skip ]; then ae_info "JAVA_HOME check skipped"
elif [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  _pk_java=$(sed -n 's/^JAVA_VERSION="\([^"]*\)"/\1/p' "$JAVA_HOME/release" 2>/dev/null)
  if [ "$_pk_java" = "$(_pk_pin tools java)" ]; then ae_ok "JAVA_HOME points to the pinned JDK"; else ae_fail "JAVA_HOME JDK differs from pin"; fi
else ae_fail "JAVA_HOME missing or not a JDK"; fi
# npm metadata avoids CLIs that print versions to stderr or start login flows.
while IFS='|' read -r _pk_pkg _pk_ref _pk_cmd _pk_selection; do
  case "$_pk_pkg" in ''|'#'*) continue ;; esac
  _pk_pkg=$(echo "$_pk_pkg" | xargs); _pk_ref=$(echo "$_pk_ref" | xargs); _pk_cmd=$(echo "$_pk_cmd" | xargs)
  [ "$(echo "$_pk_selection" | xargs)" = - ] || continue
  _pk_area=${_pk_ref%%.*}; _pk_name=${_pk_ref#*.}
  _pk_want=$(_pk_pin "$_pk_area" "$_pk_name")
  [ "$_pk_want" != skip ] || continue
  _pk_have=$(node -p 'require(process.argv[1]).version' "$HOME/.local/lib/node_modules/$_pk_pkg/package.json" 2>/dev/null || true)
  if [ "$_pk_have" = "$_pk_want" ] && ae_have "$_pk_cmd"; then ae_ok "$_pk_cmd $_pk_have"
  else ae_fail "$_pk_cmd missing, off pin or not on PATH"; fi
done < "$REPO/packages/npm-global.txt"

# Desktop apps: inspect metadata/artifacts, never start an Electron app with --version.
if [ "$ROLE" != server ] && [ "$OS" != wsl ]; then
  # shellcheck source=../../home/.chezmoitemplates/packages/lib.sh
  . "$REPO/home/.chezmoitemplates/packages/lib.sh"
  # shellcheck source=../../home/.chezmoitemplates/packages/desktop.sh
  . "$REPO/home/.chezmoitemplates/packages/desktop.sh"
  _pk_desktop() {
    case "$(pk_cmp "$2" "$3")" in
      eq) ae_ok "$1 $2" ;;
      gt) ae_warn "$1 $2, pin $3 (self-updated)" ;;
      lt) ae_fail "$1 missing or older than pin $3" ;;
    esac
  }
  for _pk_t in t3code toolbox; do
    _pk_want=$(_pk_pin tools "$_pk_t"); [ "$_pk_want" != skip ] || continue
    if [ "$OS" = macos ]; then
      _pk_app='JetBrains Toolbox'; [ "$_pk_t" != t3code ] || _pk_app=$(ae_toml_get "$VERSIONS" tools.t3code app_name)
      _pk_have=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HOME/Applications/$_pk_app.app/Contents/Info.plist" 2>/dev/null || true)
      _pk_desktop "$_pk_t" "$(ae_semver "$_pk_have")" "$_pk_want"
    elif [ "$_pk_t" = t3code ]; then
      _pk_file="$HOME/.local/share/t3code/$_pk_want/T3-Code.AppImage"
      if [ -r "$HOME/.local/bin/t3code" ]; then
        _pk_current=$(sed -n 's/^APPIMAGE_EXTRACT_AND_RUN=1 exec "\([^"]*\)".*$/\1/p' "$HOME/.local/bin/t3code")
        [ ! -x "$_pk_current" ] || _pk_file=$_pk_current
      fi
      _pk_have=$(pk_semver "$(pk_appimage_version "$_pk_file")")
      _pk_deb=$(dpkg-query -W -f='${Status} ${Version}' "$(ae_toml_get "$VERSIONS" tools.t3code deb_package)" 2>/dev/null || true)
      case "$_pk_deb" in 'install ok installed '*) _pk_deb=$(pk_semver "$_pk_deb") ;; *) _pk_deb='' ;; esac
      if [ -n "$_pk_deb" ] && { [ -z "$_pk_have" ] || [ "$(pk_cmp "$_pk_deb" "$_pk_have")" != lt ]; }; then
        _pk_desktop 'T3 Code (deb)' "$_pk_deb" "$_pk_want"
        continue
      fi
      case "$(uname -m)" in x86_64) _pk_arch=x64 ;; aarch64|arm64) _pk_arch=arm64 ;; *) _pk_arch=unsupported ;; esac
      _pk_sum_file=$VERSIONS; _pk_sum_section=tools.t3code; _pk_sum_key="sha256_linux_$_pk_arch"
      if [ "$_pk_want" != "$(ae_toml_get "$VERSIONS" tools.t3code version)" ]; then
        # Match pins.json: checksums travel with the winning version override.
        _pk_sum_section="overrides.$MACHINE"; _pk_sum_key="t3code_sha256_linux_$_pk_arch"
        if [ -f "$_pk_local" ] && [ -n "$(ae_toml_get "$_pk_local" overrides t3code)" ]; then
          _pk_sum_file=$_pk_local; _pk_sum_section=overrides
        fi
      fi
      _pk_sum=$(ae_toml_get "$_pk_sum_file" "$_pk_sum_section" "$_pk_sum_key" | tr 'A-F' 'a-f')
      if [ "$(pk_cmp "$_pk_have" "$_pk_want")" = eq ] && [ "$(ae_sha256 "$_pk_file")" != "$_pk_sum" ]; then ae_fail 'T3 Code checksum differs'
      else _pk_desktop 'T3 Code (AppImage)' "$_pk_have" "$_pk_want"; fi
      if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ]; then
        ae_warn 'T3 Code AppImage sandbox restricted by AppArmor; use the opted-in apt desktop install or an administrator-approved AppArmor profile'
      fi
    else
      pk_toolbox_latest
      _pk_desktop 'JetBrains Toolbox' "$PK_TOOLBOX_VERSION" "$_pk_want"
    fi
  done
  if [ "$OS" = macos ]; then
    _pk_want=$(_pk_pin tools docker-desktop)
    if [ "$_pk_want" = skip ]; then ae_info 'Docker Desktop skipped'
    else
      _pk_have=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Docker.app/Contents/Info.plist 2>/dev/null || true)
      _pk_desktop 'Docker Desktop' "$(ae_semver "$_pk_have")" "$_pk_want"
    fi
  fi
  unset -f _pk_desktop 2>/dev/null || true
fi

# System-managed tools: drift is a warning (the OS package manager owns them).
_pk_check git - "$(_pk_pin tools git)" warn --version
if [ "$OS" = wsl ]; then ae_info "tailscale: WSL uses the Windows host's Tailscale"
else _pk_check tailscale - "$(_pk_pin tools tailscale)" warn version; fi
_pk_check op - "$(_pk_pin tools op)" warn --version

# Where each harness resolves (base verify checks their versions).
_pk_harness claude && _pk_check claude "$HOME/.local/bin/" "$(_pk_pin harness claude)" warn --version
_pk_harness codex && _pk_check codex "$_pk_shims/" "$(_pk_pin harness codex)" warn --version
if _pk_harness grok; then
  case "$(command -v grok 2>/dev/null)" in
    "$HOME/.grok/bin/grok"|"$HOME/.local/bin/grok") ae_ok "grok resolves to the vendor install" ;;
    '') ae_fail "grok not on PATH" ;;
    *) ae_warn "grok resolves to $(command -v grok), expected ~/.grok/bin/grok" ;;
  esac
fi
_pk_harness muse && _pk_check muse "$HOME/.local/bin/" "$(_pk_pin harness muse)" warn --version

unset _pk_local _pk_v _pk_hooked _pk_f _pk_cmd _pk_where _pk_want _pk_sev _pk_p _pk_h _pk_shims _pk_py
unset -f _pk_pin _pk_harness _pk_check 2>/dev/null || true
