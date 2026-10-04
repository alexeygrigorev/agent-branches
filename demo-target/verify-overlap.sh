#!/usr/bin/env bash
# verify-overlap.sh — proves the designed task overlap for the Agent Branches demo.
#
#   FACT 1: each reference task (T1, T2, T3) applied alone on the base passes the full suite
#   FACT 2: merging T1 with T2 produces a textual git merge conflict
#   FACT 3: merging T2 with T3 merges cleanly but the suite fails (semantic conflict);
#           the failing test is named
#   FACT 4 (run-2 gap G8): merging T1 with T3 yields a TEXTUAL git merge conflict
#           (both add a route at the same anchor in src/worker.js — real overlap,
#           not a designed-clean pair)
#
# Exit 0 iff all four facts hold. Needs git + Node >= 18 on PATH.
# Reference material lives in .harness/reference-solutions/ (NOT for demo agents);
# the script also hard-fails if .harness/ ever shows up in a task fork, since demo
# agents receive clones of the base commit only.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
REF_DIR="$HERE/.harness/reference-solutions"
BASE_SHA="$(cat "$REF_DIR/BASE")"
EXPECTED_FAIL='POST /links/bulk imports every link and returns slugs in order'
GIT_ID=(-c user.name=verify -c user.email=verify@invalid)

SCRATCH=/tmp/opencode/l5-verify
rm -rf /tmp/opencode/l5-verify
mkdir -p "$SCRATCH"
REPO="$SCRATCH/repo"

git clone --quiet "$ROOT" "$REPO"
git -C "$REPO" -c advice.detachedHead=false checkout --quiet "$BASE_SHA"

assert_no_harness() { # solutions must never be visible in a task fork (base-commit clones only)
  if [ -e "$REPO/demo-target/.harness" ] || [ -e "$REPO/.harness" ]; then
    echo "HARNESS LEAK: .harness/ present in a task fork — solutions must not ship to agents" >&2
    exit 1
  fi
}
assert_no_harness

apply_task() { # apply_task <branch> <patch>
  git -C "$REPO" checkout --quiet -B "verify/$1" "$BASE_SHA"
  git -C "$REPO" "${GIT_ID[@]}" am --quiet "$REF_DIR/$2"
  assert_no_harness
}

run_suite() { # runs node --test in the clone; TAP captured to $SCRATCH/tap.txt
  (cd "$REPO/demo-target" && exec node --test --test-reporter=tap) > "$SCRATCH/tap.txt" 2>&1
}

# ---- FACT 1: each task alone is green --------------------------------------
declare -a ALONE=(PASS PASS PASS)
for n in 1 2 3; do
  apply_task "task$n" "t$n.patch"
  if ! run_suite; then ALONE[$((n - 1))]=FAIL; fi
done
FACT1_OK=true
for s in "${ALONE[@]}"; do [ "$s" = PASS ] || FACT1_OK=false; done

# ---- FACT 2: T1 + T2 must conflict textually -------------------------------
git -C "$REPO" checkout --quiet -B verify/m12 verify/task1
set +e
MERGE12="$(git -C "$REPO" "${GIT_ID[@]}" merge --no-edit verify/task2 2>&1)"
MERGE12_RC=$?
set -e
CONFLICTED="$(git -C "$REPO" diff --name-only --diff-filter=U)"
if [ "$MERGE12_RC" -ne 0 ] && grep -q 'CONFLICT' <<<"$MERGE12" \
   && grep -qx 'demo-target/src/shortlinks.js' <<<"$CONFLICTED"; then
  FACT2_OK=true
else
  FACT2_OK=false
fi
git -C "$REPO" merge --abort >/dev/null 2>&1 || true
assert_no_harness

# ---- FACT 3: T2 + T3 merge clean but suite is red --------------------------
git -C "$REPO" checkout --quiet -B verify/m23 verify/task2
set +e
MERGE23="$(git -C "$REPO" "${GIT_ID[@]}" merge --no-edit verify/task3 2>&1)"
MERGE23_RC=$?
set -e
assert_no_harness
if [ "$MERGE23_RC" -eq 0 ]; then
  if run_suite; then SUITE23_RC=0; else SUITE23_RC=$?; fi
  FAILING="$(grep '^not ok' "$SCRATCH/tap.txt" | sed -E 's/^not ok [0-9]+ - //' || true)"
  if [ "$SUITE23_RC" -ne 0 ] && grep -Fxq "$EXPECTED_FAIL" <<<"$FAILING"; then
    FACT3_OK=true
  else
    FACT3_OK=false
  fi
else
  SUITE23_RC=-1
  FAILING=""
  FACT3_OK=false
fi

# ---- FACT 4: T1 + T3 must conflict textually (real overlap, G8) -------------
git -C "$REPO" checkout --quiet -B verify/m13 verify/task1
set +e
MERGE13="$(git -C "$REPO" "${GIT_ID[@]}" merge --no-edit verify/task3 2>&1)"
MERGE13_RC=$?
set -e
CONFLICTED13="$(git -C "$REPO" diff --name-only --diff-filter=U)"
if [ "$MERGE13_RC" -ne 0 ] && grep -q 'CONFLICT' <<<"$MERGE13" \
   && grep -qx 'demo-target/src/worker.js' <<<"$CONFLICTED13"; then
  FACT4_OK=true
else
  FACT4_OK=false
fi
git -C "$REPO" merge --abort >/dev/null 2>&1 || true
assert_no_harness

# ---- report ----------------------------------------------------------------
echo "demo-target overlap verification (base ${BASE_SHA:0:10})"
echo
echo "GUARD — .harness/ absent from every task fork (solutions cannot ship): OK"
echo
echo "FACT 1 — each task alone passes the full suite:"
echo "         T1=${ALONE[0]}  T2=${ALONE[1]}  T3=${ALONE[2]}"
echo
echo "FACT 2 — merging T1 with T2 yields a TEXTUAL git merge conflict:"
if [ "$FACT2_OK" = true ]; then
  echo "         CONFLICT in: $(echo "$CONFLICTED" | tr '\n' ' ')"
else
  echo "         NOT REPRODUCED (merge rc=$MERGE12_RC) — see $SCRATCH"
fi
echo
echo "FACT 3 — merging T2 with T3 is clean but the suite FAILS (SEMANTIC conflict):"
if [ "$FACT3_OK" = true ]; then
  echo "         merge rc=0 (clean); failing test: \"$EXPECTED_FAIL\""
else
  echo "         NOT REPRODUCED (merge rc=$MERGE23_RC, suite rc=$SUITE23_RC) — see $SCRATCH"
fi
echo

echo "FACT 4 — merging T1 with T3 yields a TEXTUAL git merge conflict (real overlap, G8):"
if [ "$FACT4_OK" = true ]; then
  echo "         CONFLICT in: $(echo "$CONFLICTED13" | tr '\n' ' ')"
else
  echo "         NOT REPRODUCED (merge rc=$MERGE13_RC)"
fi
echo

if [ "$FACT1_OK" = true ] && [ "$FACT2_OK" = true ] && [ "$FACT3_OK" = true ] && [ "$FACT4_OK" = true ]; then
  echo "ALL 4 FACTS VERIFIED"
  exit 0
fi
echo "VERIFICATION FAILED"
exit 1
