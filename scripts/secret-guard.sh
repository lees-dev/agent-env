#!/bin/sh
# Secret and privacy guard for the files git tracks. CI runs it on every push and pull request
# (.github/workflows/secret-scan.yml); run it yourself before every commit: sh scripts/secret-guard.sh
#
# Fails on, in any tracked file (content or path):
#   1. API keys shaped like sk-...           (CLIProxy client keys and most vendor keys)
#   2. private-key PEM headers
#   3. other token shapes: GitHub (ghp_ gho_ ghu_ ghs_ ghr_ github_pat_), Tailscale (tskey-),
#      1Password service accounts (ops_), Slack (xox?-)
#   4. email addresses, except those allowlisted in .secret-guard-allow
#   5. forbidden file names: credential, OAuth, key, log and runtime-state files
#   6. CRLF line endings in the index (the .gitattributes eol=lf rule)
#   7. 1Password template functions outside home/.chezmoitemplates/secrets/, and any
#      source file that includes a secrets/ partial without a private_ (or run_) name
# Prints file:line and the kind of finding, never the matched value.
set -u

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$REPO" || exit 2
ALLOW=.secret-guard-allow
fail=0
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT INT TERM

report() { # report <kind> ; reads "path:line[:match]" lines on stdin, prints path:line only
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    printf '  FAIL  %s  %s\n' "$1" "$(printf '%s' "$hit" | cut -d: -f1-2)"
    fail=1
  done
}

# Pattern shapes are written so that this file never matches itself.
SELF=':(exclude)scripts/secret-guard.sh'

# 1-3. Token shapes (git grep -I skips binary files).
git grep -nIE '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}' -- . "$SELF" > "$TMP" 2>/dev/null
report "api-key(sk-)" < "$TMP"
git grep -nIE 'BEGIN ([A-Z0-9]+ )*PRIVATE KEY' -- . "$SELF" > "$TMP" 2>/dev/null
report "private-key" < "$TMP"
git grep -nIE '(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|tskey-[a-z]+-[A-Za-z0-9]{8,}|ops_[A-Za-z0-9]{40,}|xox[abpors]-[A-Za-z0-9-]{10,})' -- . "$SELF" > "$TMP" 2>/dev/null
report "token" < "$TMP"

# 4. Email addresses in content and in paths.
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
allowed_email() { # allowed_email <address>
  [ -f "$ALLOW" ] || return 1
  a=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
  while IFS= read -r rule; do
    case "$rule" in
      email:@*) case "$a" in *"${rule#email:}") return 0 ;; esac ;;
      email:*) [ "$a" = "${rule#email:}" ] && return 0 ;;
    esac
  done < "$ALLOW"
  return 1
}
allowed_path() { # allowed_path <path>
  [ -f "$ALLOW" ] || return 1
  while IFS= read -r rule; do
    case "$rule" in
      path:*)
        # The rule is a shell glob (see the allowlist header), so it stays unquoted to match as one.
        # shellcheck disable=SC2254
        case "$1" in ${rule#path:}) return 0 ;; esac ;;
    esac
  done < "$ALLOW"
  return 1
}
git grep -nIoE "$EMAIL" -- . "$SELF" ":(exclude)$ALLOW" > "$TMP" 2>/dev/null
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  path=$(printf '%s' "$hit" | cut -d: -f1)
  addr=$(printf '%s' "$hit" | cut -d: -f3-)
  allowed_path "$path" && continue
  allowed_email "$addr" && continue
  printf '  FAIL  email  %s\n' "$(printf '%s' "$hit" | cut -d: -f1-2)"
  fail=1
done < "$TMP"
git ls-files | grep -E "$EMAIL" | sed 's/$/:-/' > "$TMP"
report "email-in-path" < "$TMP"

# 5. Forbidden file names (matched on the last path component, case-insensitive).
git ls-files | awk -F/ '
  { n = tolower($NF) }
  n ~ /^(auth\.json(\..*)?|\.credentials\.json|credentials(\.json)?|hosts\.yml|state\.json|cpa-key(\.txt)?|\.env(\..*)?)$/ ||
  n ~ /^(id_(rsa|ed25519|ecdsa).*|client-api-key.*\.txt|mcp_oauth.*)$/ ||
  n ~ /\.(pem|key|p12|pfx|age|log|sqlite|db)$/ { print $0 ":-" }' > "$TMP"
report "forbidden-file" < "$TMP"
git ls-files | grep -E '(^|/)(oauth|logs)/' | sed 's/$/:-/' > "$TMP"
report "forbidden-dir" < "$TMP"

# 6. CRLF in the index.
git ls-files --eol | awk '$1 ~ /^i\/(crlf|mixed)$/ {print $NF ":-"}' > "$TMP"
report "crlf" < "$TMP"

# 7. 1Password functions only in the secrets partials; their users must be private_ or run_.
git grep -nIE '(^|[^A-Za-z])onepassword[A-Za-z]*([^A-Za-z]|$)' -- home ':(exclude)home/.chezmoitemplates/secrets/*' ':(exclude)home/.chezmoi.toml.tmpl' > "$TMP" 2>/dev/null
report "op-outside-secrets" < "$TMP"
git grep -lIE '[tT]emplate "secrets/' -- home 2>/dev/null | while IFS= read -r f; do
  base=${f##*/}
  case "$base" in *private_*|run_*) ;; *) printf '%s:0\n' "$f" ;; esac
done > "$TMP"
report "secret-in-non-private-target" < "$TMP"

if [ "$fail" -eq 0 ]; then
  echo "secret-guard: clean ($(git ls-files | wc -l | tr -d ' ') tracked files)"
else
  echo "secret-guard: findings above (values not printed). Remove them from the file AND from history before pushing."
fi
exit "$fail"
