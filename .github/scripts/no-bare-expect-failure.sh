#!/usr/bin/env bash
# no-bare-expect-failure.sh — every negative test must name the error it expects.
#
# WHY. `(expect-failure "doc" <expr>)` passes on ANY error, including one that has
# nothing to do with the property being tested: a typo in a data key makes the call
# fail with `read-keyset failure` instead of the guard check it was meant to exercise,
# and the suite stays green. A negative test that cannot tell WHY it failed is not
# evidence that the defence works — only that something went wrong.
#
# The three-argument form `(expect-failure "doc" "expected message" <expr>)` fixes
# it. To find the message, temporarily pass one that cannot match; the failure
# output reports what was actually raised.
#
# Exit 0 = clean. Exit 1 = at least one bare expectation, or no test file found at
# all: a check that inspected nothing must never report success.
set -euo pipefail
cd "$(dirname "$0")/../.."

python3 - <<'PY'
import os, re, sys

paths = []
for root, dirs, files in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]
    paths += [os.path.join(root, f) for f in files if f.endswith(('.repl', '.repl-must-fail'))]
paths.sort()
if not paths:
    print("FAIL: no .repl files found — the check inspected nothing")
    sys.exit(1)

bare = []
for path in paths:
    src = open(path).read()
    # After the doc string, the next non-space character must open another string
    # literal (the expected message). Anything else means the form is bare.
    for m in re.finditer(r'\(expect-failure\s+"(?:[^"\\]|\\.)*"\s*(.)', src, re.S):
        if m.group(1) != '"':
            line = src[:m.start()].count('\n') + 1
            doc = re.match(r'\(expect-failure\s+"((?:[^"\\]|\\.)*)"', src[m.start():], re.S)
            bare.append((path, line, (doc.group(1) if doc else '')[:70]))

if bare:
    print(f"FAIL: {len(bare)} bare expect-failure(s) — each passes on ANY error:\n")
    for path, line, doc in bare:
        print(f"  {path}:{line}  {doc}")
    print("\nUse (expect-failure \"doc\" \"expected message\" <expr>).")
    sys.exit(1)

print(f"no bare expect-failure in {len(paths)} files: every negative test names its expected error")
PY
