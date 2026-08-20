#!/usr/bin/env bash
# Both halves of the benchmark, one after the other.
#
# The QML column is the one that matters — the shell runs that engine, not
# node's — so this is worth running on the machine the shell runs on rather
# than wherever the code was written.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node tests/bench_node.js

runtime=""
for candidate in qml6 qml /usr/lib/qt6/bin/qml; do
  if command -v "$candidate" >/dev/null 2>&1; then
    runtime=$candidate
    break
  fi
done

if [[ -z $runtime ]]; then
  printf '\nNo qml runtime on PATH, so only the V8 column ran.\n'
  printf 'It ships with qt6-declarative; install that and run this again.\n'
  exit 0
fi

printf '\n'
# A benchmark, not a test: a QML runtime that will not start is worth saying out
# loud, but it is not a reason to fail the target.
if ! "$runtime" tests/bench_html.qml; then
  printf '\nThe QML column did not run: %s exited non-zero above.\n' "$runtime"
  printf 'On a machine where the shell itself runs, that is worth looking into.\n'
fi
