#!/usr/bin/env bash
# leak-scan.sh — refuse anything that must never be published. Scans every tracked file.
# Runs in CI on every push, and locally before every release. Exit 1 on any hit.
#
# Every pattern is written with a character class so that this file never matches itself: a scan
# that fails on every run gets switched off, which is worse than having no scan.
set -euo pipefail
cd "$(dirname "$0")/../.."

files=()
while IFS= read -r -d '' f; do files+=("$f"); done < <(git ls-files -z)
[ "${#files[@]}" -gt 0 ] || { echo "::error::no tracked files found — the scan inspected nothing"; exit 1; }

fail=0
check() {  # $1 what must not appear, $2 extended regex (case-insensitive)
  local hits
  hits=$(grep -nIiE -e "$2" -- "${files[@]}" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    echo "::error::found: $1"
    fail=1
  else
    echo "ok: no $1"
  fi
}

check "private filesystem path"             '/(home|Users)/[a-z]'
check "personal email address"              '@(gmail|yahoo|hotmail|outlook|icloud|proton(mail)?)\.[c]om'
check "co-author trailer or tool footer"    'co-authored-b[y]|generated wit[h]'
check "private key material"                'BEGIN [A-Z ]*PRIVATE KE[Y]'

# Files that hold local configuration or keys never belong in the repository. devnet/.env is the
# one exception, by design: docker compose reads it, and it holds only public devnet settings.
names=$(git ls-files | grep -iE '\.en[v]$|-ke[y]\.json$' | grep -vx 'devnet/\.env' || true)
if [ -n "$names" ]; then printf '%s\n' "$names"; echo "::error::a file that must stay local is tracked"; fail=1
else echo "ok: no local-only file is tracked"; fi

echo "scanned ${#files[@]} tracked files"
exit "$fail"
