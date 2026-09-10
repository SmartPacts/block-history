#!/usr/bin/env bash
# run.sh — the suite. Exit 0 only when EVERYTHING below holds.
#   1. the static gate exits 0 on every .pact/.repl
#   2. every negative test names its expected error
#   3. every suite exits 0 AND prints no FAILURE line (both are checked; PIPESTATUS,
#      never $? after a pipe)
#   4. the must-fail fixture is refused, and refused for the stated reason
#   5. the vision pins are load-bearing: each generated mutant makes vision-pin.repl FAIL
#   6. the module reaches its tables through exactly the DML the design allows
set -u
cd "$(dirname "$0")" || exit 1
ROOT=$(cd ../.. && pwd)
MOD=../modules/block-history.pact
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

# 1. static gate
if "$ROOT/.github/scripts/pact-static-check.sh" "$MOD" ./*.repl >/tmp/bh-static.out 2>&1; then ok "static gate ($(grep -c . /tmp/bh-static.out) lines, see /tmp/bh-static.out)"
else bad "static gate"; cat /tmp/bh-static.out; fi

# 2. no bare expect-failure
if "$ROOT/.github/scripts/no-bare-expect-failure.sh" >/dev/null 2>&1; then ok "no-bare-expect-failure"
else bad "no-bare-expect-failure"; "$ROOT/.github/scripts/no-bare-expect-failure.sh"; fi

# 3. suites
for f in block-history.repl negatives.repl vision-pin.repl gas.repl namespace-claim.repl; do
  out=$(pact "$f" 2>&1); e=$?
  nf=$(printf '%s\n' "$out" | grep -c 'FAILURE')
  if [ "$e" -eq 0 ] && [ "$nf" -eq 0 ]; then ok "$f"
  else bad "$f (exit=$e FAILURE-lines=$nf)"; printf '%s\n' "$out" | grep -E 'FAILURE|error|Error' | head -20; fi
done
pact gas.repl 2>&1 | grep '^"gas ' | tr -d '"'

# 4. must-fail fixture: refused, and for the right reason
if pact frozen.repl-must-fail >/dev/null 2>&1; then bad "frozen.repl-must-fail LOADED — the immutable module was upgraded"
elif pact frozen.repl-must-fail 2>&1 | grep -q "block-history is immutable"; then ok "frozen.repl-must-fail (refused: block-history is immutable)"
else bad "frozen.repl-must-fail failed for the WRONG reason"; pact frozen.repl-must-fail 2>&1 | tail -5; fi

# 5. vision pins are load-bearing. Mutants are GENERATED from the real module (never
#    hand-edited) into a temp dir, and each must turn vision-pin.repl RED.
MUT=$(mktemp -d); mkdir -p "$MUT/modules" "$MUT/tests"
cp vision-pin.repl "$MUT/tests/"
mutant() {  # $1 name, $2.. sed expressions
  local name=$1; shift
  sed "$@" "$MOD" > "$MUT/modules/block-history.pact"
  if cmp -s "$MOD" "$MUT/modules/block-history.pact"; then bad "mutant $name: sed matched nothing (anchor drifted)"; return; fi
  if (cd "$MUT/tests" && pact vision-pin.repl >/dev/null 2>&1); then bad "mutant $name: vision-pin.repl stayed GREEN — the pin is not load-bearing"
  else ok "mutant $name turns vision-pin.repl RED"; fi
}
mutant fallback -e 's|^    (read attested (key height)))$|    (with-default-read attested (key height) { "hash": "" } { "hash" := h0 } (if (!= h0 "") (read attested (key height)) (read backfilled (key height)))))|'
mutant shadow   -e 's|(enforce (= a "") "block-history: backfill: height is already attested")|true|'
mutant rewrite  -e 's|(if (!= have "")|(if false|' -e 's|(insert attested k|(write attested k|'
rm -rf "$MUT"

# 6. DML inventory: attested is written by exactly one insert; backfilled by exactly one
#    insert; no update anywhere; write only on the two single-row state tables.
ins_att=$(grep -c '(insert attested ' "$MOD"); ins_bf=$(grep -c '(insert backfilled ' "$MOD")
upd=$(grep -c '(update ' "$MOD"); wr_bad=$(grep -cE '\(write (attested|backfilled) ' "$MOD")
if [ "$ins_att" -eq 1 ] && [ "$ins_bf" -eq 1 ] && [ "$upd" -eq 0 ] && [ "$wr_bad" -eq 0 ]; then ok "DML inventory (1 insert per record table, no update, no write to a record table)"
else bad "DML inventory: insert attested=$ins_att insert backfilled=$ins_bf update=$upd write-to-record-table=$wr_bad"; fi

echo "SUITE RESULT: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
