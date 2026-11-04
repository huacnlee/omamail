#!/usr/bin/env bash
# test_source.sh pins bundled assets by SHA-256. Linux names the tool
# `sha256sum`; `shasum` is the macOS name, and Arch keeps it in
# /usr/bin/core_perl, outside a non-login PATH. Run the real source check with
# `sha256sum` reachable and `shasum` not, so an unconditional `shasum` call
# fails here instead of stopping `make validate` partway on a clean Arch shell.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

fail() { printf 'test_source_hash_tools.sh: %s\n' "$1" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-source-hash.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP
mkdir "$work/bin"

# A symlink resolves a relative target from its own directory, so every path
# is made absolute from where this script was started. An empty PATH entry
# means that directory too.
absolute() {
  case $1 in
    /*) printf '%s\n' "$1" ;;
    '') printf '%s\n' "$PWD" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

# Mirror every command on PATH except the two hash tools, first match winning
# as it would in a lookup. Symlinks keep each tool's own resolution intact.
# The appended colon keeps a trailing empty entry, which `read` would drop.
IFS=: read -r -a path_dirs <<<"$PATH:"
for dir in "${path_dirs[@]}"; do
  dir=$(absolute "$dir")
  [ -d "$dir" ] || continue
  for tool in "$dir"/*; do
    name=${tool##*/}
    case $name in shasum | sha256sum) continue ;; esac
    [ -x "$tool" ] && [ ! -d "$tool" ] || continue
    [ ! -e "$work/bin/$name" ] && [ ! -L "$work/bin/$name" ] || continue
    ln -s "$tool" "$work/bin/$name"
  done
done

# The real `sha256sum` where the host has one; on a host with only `shasum`,
# a wrapper that calls it by absolute path, so the scenario stays the same.
if real=$(command -v sha256sum); then
  ln -s "$(absolute "$real")" "$work/bin/sha256sum"
else
  real=$(command -v shasum) || fail "the host has neither sha256sum nor shasum"
  printf '#!/bin/sh\nexec "%s" -a 256 "$@"\n' "$(absolute "$real")" > "$work/bin/sha256sum"
  chmod +x "$work/bin/sha256sum"
fi

! PATH="$work/bin" command -v shasum >/dev/null 2>&1 \
  || fail "the restricted PATH must not provide shasum"
PATH="$work/bin" command -v sha256sum >/dev/null 2>&1 \
  || fail "the restricted PATH must provide sha256sum"

if ! output=$(PATH="$work/bin" bash "$root/tests/test_source.sh" 2>&1); then
  printf '%s\n' "$output" >&2
  fail "the source check must pass with sha256sum and without shasum"
fi
case $output in
  *"test_source.sh ok"*) ;;
  *) printf '%s\n' "$output" >&2; fail "the source check did not reach its end" ;;
esac

printf 'test_source_hash_tools.sh ok\n'
