# shellcheck shell=sh
# rules+skills verify drop-in (WSL, Linux, macOS). Sourced by scripts/verify: never exits.
# Read-only. Prints counts and skill names, never file contents.
# Uses REPO and HARNESSES from scripts/verify, and the ae_* helpers.

_s_names=$(for _s_d in "$REPO"/home/dot_agents/skills/exact_*; do [ -d "$_s_d" ] && printf '%s ' "${_s_d##*/exact_}"; done)
_s_total=$(echo $_s_names | wc -w | tr -d ' ')
_s_agents="$HOME/.agents/skills"
_s_claude="$HOME/.claude/skills"

# 1. The canonical copies are deployed.
_s_bad=''
for _s_n in $_s_names; do [ -f "$_s_agents/$_s_n/SKILL.md" ] || _s_bad="$_s_bad $_s_n"; done
if [ -z "$_s_bad" ]; then ae_ok "$_s_total canonical skills in ~/.agents/skills"
else ae_fail "canonical skills missing from ~/.agents/skills:$_s_bad"; ae_hint "scripts/backup && chezmoi apply --force --no-tty"
fi

# 2. ~/.claude/skills/<name> links to the canonical copy.
case " $HARNESSES " in
  *" claude "*)
    _s_ok=0; _s_missing=''; _s_real=''; _s_wrong=''
    for _s_n in $_s_names; do
      _s_l="$_s_claude/$_s_n"
      if [ -L "$_s_l" ]; then
        if [ "$(readlink "$_s_l")" = "$_s_agents/$_s_n" ] && [ -e "$_s_l" ]; then _s_ok=$((_s_ok + 1)); else _s_wrong="$_s_wrong $_s_n"; fi
      elif [ -e "$_s_l" ]; then _s_real="$_s_real $_s_n"
      else _s_missing="$_s_missing $_s_n"
      fi
    done
    [ "$_s_ok" -eq "$_s_total" ] && ae_ok "$_s_ok/$_s_total ~/.claude/skills entries link to ~/.agents/skills"
    [ -z "$_s_missing" ] || { ae_fail "no link in ~/.claude/skills for:$_s_missing"; ae_hint "chezmoi apply (run_after_20-skills-links makes them)"; }
    [ -z "$_s_wrong" ] || { ae_fail "link points elsewhere or dangles:$_s_wrong"; ae_hint "chezmoi apply (the link script records and replaces it)"; }
    [ -z "$_s_real" ] || { ae_fail "real copy differs from the canonical skill, left in place:$_s_real"
      ae_hint "compare it with ~/.agents/skills/<name>; move wanted changes into the agent-env repo, delete the copy, then chezmoi apply"; }
    [ -d "$_s_claude/synced" ] && ae_info '~'"/.claude/skills/synced is app-managed and left alone"
    ;;
  *) ae_info "claude not selected: no ~/.claude/skills links expected" ;;
esac

# 3. Dangling links in the skill trees (for example a stale `waves` link inside a skill).
_s_dang=0
for _s_root in "$_s_claude" "$_s_agents"; do
  [ -d "$_s_root" ] || continue
  _s_c=$(find "$_s_root" -maxdepth 3 -type l ! -exec test -e {} \; -print 2>/dev/null | wc -l | tr -d ' ')
  _s_dang=$((_s_dang + _s_c))
done
if [ "$_s_dang" -eq 0 ]; then ae_ok "no dangling links in ~/.claude/skills or ~/.agents/skills"
else ae_warn "$_s_dang dangling links in ~/.claude/skills or ~/.agents/skills"; ae_hint "find ~/.claude/skills ~/.agents/skills -maxdepth 3 -xtype l"
fi

# 4. Rules files carry the managed header (content parity is chezmoi verify's job).
for _s_h in claude codex grok; do
  case " $HARNESSES " in *" $_s_h "*) ;; *) continue ;; esac
  case "$_s_h" in claude) _s_f="$HOME/.claude/CLAUDE.md" ;; *) _s_f="$HOME/.$_s_h/AGENTS.md" ;; esac
  if [ -f "$_s_f" ] && grep -q 'Managed by agent-env' "$_s_f"; then ae_ok "$_s_h global rules are the agent-env copy"
  else ae_fail "$_s_h global rules are not the agent-env copy (${_s_f#"$HOME"/})"; ae_hint "scripts/backup && chezmoi apply --force --no-tty"
  fi
done
case " $HARNESSES " in
  *" grok "*)
    # Tested on Grok 1.0.70 with a throwaway home (2026-11-04): neither [compat.claude] agents = false
    # nor rules = false stops it loading ~/.claude/CLAUDE.md, so there is nothing to set (docs/skills.md).
    ae_info "grok also loads ~/.claude/CLAUDE.md (no working switch in 1.0.70; docs/skills.md)" ;;
esac
case " $HARNESSES " in
  *" muse "*) ae_info "muse: rules come from a one-time /rules import (docs/skills.md); rerun it after the rules change" ;;
esac

# 5. Every managed rules block comes from agent-env. The interim ~/bin/sync-agent-standards
#    wrote the same blocks with its own marker; agent-env now ships all five, so the tool is
#    only reported, and a block it rewrote fails here (and in chezmoi verify).
for _s_h in claude codex grok; do
  case " $HARNESSES " in *" $_s_h "*) ;; *) continue ;; esac
  case "$_s_h" in claude) _s_f="$HOME/.claude/CLAUDE.md" ;; *) _s_f="$HOME/.$_s_h/AGENTS.md" ;; esac
  [ -f "$_s_f" ] || continue
  _s_miss=0
  for _s_b in engineering-standards subagent-routing t3-first credentials repo-defaults; do
    grep -q "^<!-- BEGIN $_s_b (managed by agent-env;" "$_s_f" || _s_miss=$((_s_miss + 1))
  done
  if [ "$_s_miss" -eq 0 ]; then ae_ok "$_s_h rules carry all 5 agent-env managed blocks"
  else ae_fail "$_s_h rules: $_s_miss of 5 managed blocks missing or not from agent-env"; ae_hint "scripts/backup && chezmoi apply --force --no-tty"
  fi
done
if [ -e "$HOME/bin/sync-agent-standards" ]; then
  ae_info '~'"/bin/sync-agent-standards is superseded by agent-env (it ships every managed block); it may be deleted"
fi

# 6. The backup list names every exact_ skill directory (apply --force deletes whatever the
#    repo lacks in it) and every link the script may replace.
_s_list="$REPO/scripts/backup.d/20-skills.list"
_s_lc=$(sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' "$_s_list" 2>/dev/null | sort | tr '\n' ' ')
_s_want=$(for _s_n in $_s_names; do echo ".agents/skills/$_s_n"; echo ".claude/skills/$_s_n"; done | sort | tr '\n' ' ')
[ "$_s_lc" = "$_s_want" ] || ae_warn "scripts/backup.d/20-skills.list does not match the skill list (repo fix)"

unset _s_names _s_total _s_agents _s_claude _s_bad _s_n _s_ok _s_missing _s_real _s_wrong _s_l _s_dang _s_root _s_c _s_h _s_f _s_list _s_lc _s_want _s_d
