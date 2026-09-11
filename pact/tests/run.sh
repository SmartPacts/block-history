#!/usr/bin/env bash
# run.sh — the suite. Exit 0 only when EVERYTHING below holds.
#   1. the static gate exits 0 on every .pact/.repl
#   2. every negative test names its expected error
#   3. every suite exits 0 AND prints no FAILURE line (both are checked)
#   4. the must-fail fixture is refused, for the stated reason, and only because of the
#      governance: the same file goes through against a copy whose governance is open
#   5. the vision pins are load-bearing: each generated mutant makes vision-pin.repl FAIL,
#      at the pin that guards the clause it breaks
#   6. only attest writes rows: the module's DML is exactly attest's insert into `attested`
#      and its write of the `latest-tbl` row, and the same check refuses a second writer
set -u
cd "$(dirname "$0")" || exit 1
ROOT=$(cd ../.. && pwd)
MOD=../modules/block-history.pact
MUT=$(mktemp -d); trap 'rm -rf "$MUT"' EXIT
mkdir -p "$MUT/modules" "$MUT/tests"
cp harness.repl vision-pin.repl frozen.repl-must-fail "$MUT/tests/"
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

# Mutants are GENERATED from the real module by sed, never hand-edited. gen writes one where
# the copied suites load it from, and fails when the sed matched nothing (an anchor drifted).
gen() {  # $1.. sed expressions
  sed "$@" "$MOD" > "$MUT/modules/block-history.pact"
  ! cmp -s "$MOD" "$MUT/modules/block-history.pact"
}
GOV_OPEN='s|(enforce false "block-history is immutable: it can never be upgraded")|(enforce true "block-history is immutable: it can never be upgraded")|'
SECOND_WRITER='s|^      { "height": h, "hash": bh, "time": bt }))$|      (let ((w (write latest-tbl "latest" { "height": h, "hash": bh, "time": bt }))) { "height": h, "hash": bh, "time": bt })))|'

# 1. static gate
if "$ROOT/.github/scripts/pact-static-check.sh" "$MOD" ./*.repl >/tmp/bh-static.out 2>&1; then ok "static gate ($(grep -c . /tmp/bh-static.out) lines, see /tmp/bh-static.out)"
else bad "static gate"; cat /tmp/bh-static.out; fi

# 2. no bare expect-failure
if "$ROOT/.github/scripts/no-bare-expect-failure.sh" >/dev/null 2>&1; then ok "no-bare-expect-failure"
else bad "no-bare-expect-failure"; "$ROOT/.github/scripts/no-bare-expect-failure.sh"; fi

# 3. suites
for f in block-history.repl negatives.repl vision-pin.repl gas.repl deploy.repl; do
  out=$(pact "$f" 2>&1); e=$?
  nf=$(printf '%s\n' "$out" | grep -c 'FAILURE')
  if [ "$e" -eq 0 ] && [ "$nf" -eq 0 ]; then ok "$f"
  else bad "$f (exit=$e FAILURE-lines=$nf)"; printf '%s\n' "$out" | grep -E 'FAILURE|error|Error' | head -20; fi
done
pact gas.repl 2>&1 | grep '^"gas ' | tr -d '"'

# 4. must-fail fixture: refused, for the right reason, and by the governance alone
if pact frozen.repl-must-fail >/dev/null 2>&1; then bad "frozen.repl-must-fail LOADED — the immutable module was upgraded"
elif pact frozen.repl-must-fail 2>&1 | grep -q "block-history is immutable"; then ok "frozen.repl-must-fail (refused: block-history is immutable)"
else bad "frozen.repl-must-fail failed for the WRONG reason"; pact frozen.repl-must-fail 2>&1 | tail -5; fi
if ! gen -e "$GOV_OPEN"; then bad "fixture control: sed matched nothing (anchor drifted)"
elif out=$(cd "$MUT/tests" && pact frozen.repl-must-fail 2>&1) && grep -q "MUST NEVER PRINT" <<<"$out"; then ok "fixture control: with governance open, the same file goes through"
else bad "fixture control: the file fails even with governance open, so its refusal is not the governance"; tail -5 <<<"$out"; fi

# 5. vision pins are load-bearing. Each mutant must turn vision-pin.repl RED at the pin that
#    guards its clause: a FAILURE line containing $2, with $3 on it or on the line after it
#    (where the REPL prints the error an expectation's own evaluation raised). FAILURE lines
#    go to stdout; stderr is kept apart so it cannot split one. A 3-argument expect-failure
#    that succeeds prints its expected message where the label would be.
mutant() {  # $1 name, $2 FAILURE-line text, $3 evidence, $4.. sed expressions
  local name=$1 pin=$2 why=$3 win; shift 3
  if ! gen "$@"; then bad "mutant $name: sed matched nothing (anchor drifted)"; return; fi
  if (cd "$MUT/tests" && pact vision-pin.repl >"$MUT/out" 2>"$MUT/err"); then bad "mutant $name: vision-pin.repl stayed GREEN — the pin is not load-bearing"; return; fi
  win=$(grep -F -A1 -- "FAILURE: $pin" "$MUT/out")
  if grep -qF -- "$why" <<<"$win"; then ok "mutant $name turns vision-pin.repl RED ($pin: $why)"
  else bad "mutant $name: RED for the wrong reason (no \"FAILURE: $pin\" showing \"$why\")"; grep -A1 'FAILURE' "$MUT/out" | head -6; tail -3 "$MUT/err"; fi
}
mutant caller-value  'VISION-1a' '"CALLER-HASH"' \
  -e "s|(bh (at 'prev-block-hash cd))|(bh (read-msg 'hash))|"
mutant takes-arg     'Attempted to apply a closure to too many arguments' 'got result: "recorded"' \
  -e 's|(defun attest:string ()|(defun attest:string (bh:string)|' -e "/(bh (at 'prev-block-hash cd))/d"
mutant rewrite       'VISION-3 ' 'Operation disallowed in read-only or sys-only mode' \
  -e 's|(if (!= have "")|(if false|' -e 's|(insert attested k|(write attested k|'
mutant abort-dup     'VISION-3 ' 'received: "ABORTED"' \
  -e 's|^              "already recorded"$|              (enforce false "mutant: a duplicate aborts")|'
mutant gov-open      'block-history is immutable' 'got result: "Module admin for module free.block-history acquired"' \
  -e "$GOV_OPEN"
mutant second-writer 'VISION-5 latest' 'Operation disallowed in read-only or sys-only mode' \
  -e "$SECOND_WRITER"

# 6. DML inventory. Every row-writing native (insert, update, write) in the module, with the
#    definition it sits in and the token after it; comments and string contents are ignored.
dml() {  # $1 module file
  python3 - "$1" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
code, i, instr = [], 0, False
while i < len(src):
    c = src[i]
    if instr:
        if c == '\\': i += 2; continue
        if c == '"': instr = False
        i += 1; continue
    if c == '"': instr = True; code.append(' '); i += 1; continue
    if c == ';':
        j = src.find('\n', i); i = len(src) if j < 0 else j; continue
    code.append(c); i += 1
toks = re.findall(r'[()]|[^\s()]+', ''.join(code))
owners, found = [], []
for k, t in enumerate(toks):
    if t == '(': owners.append(None)
    elif t == ')': owners.pop()
    elif k > 0 and toks[k-1] == '(' and t in ('defun', 'defcap', 'defpact', 'defconst', 'defschema', 'deftable') and k + 1 < len(toks):
        owners[-1] = toks[k+1].split(':')[0]
    if t in ('insert', 'update', 'write'):
        owner = next((o for o in reversed(owners) if o), '<top level>')
        found.append(f"{owner} {t} {toks[k+1] if k + 1 < len(toks) else ''}")
print('\n'.join(sorted(found)))
PY
}
want=$'attest insert attested\nattest write latest-tbl'
got=$(dml "$MOD")
if [ "$got" = "$want" ]; then ok "DML inventory (attest's insert into attested and its latest-tbl write, nothing else)"
else bad "DML inventory: expected [${want//$'\n'/; }], got [${got//$'\n'/; }]"; fi
if ! gen -e "$SECOND_WRITER"; then bad "DML control: sed matched nothing (anchor drifted)"
elif [ "$(dml "$MUT/modules/block-history.pact")" = "$want" ]; then bad "DML control: the inventory passed a module whose latest writes a row — it is blind"
else ok "DML control: the inventory refuses a module whose latest writes a row"; fi

echo "SUITE RESULT: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
