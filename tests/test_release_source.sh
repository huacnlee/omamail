#!/usr/bin/env bash
# scripts/release-source.sh: which branch a Release run publishes from, and
# the refusals that keep a tag or dispatch from publishing the wrong revision.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

git init -q --bare "$root/origin.git"
git init -q -b main "$root/clone"
git -C "$root/clone" config user.name Tester
git -C "$root/clone" config user.email tester@example.test
git -C "$root/clone" commit -q --allow-empty -m "Initial"
git -C "$root/clone" remote add origin "$root/origin.git"
git -C "$root/clone" push -q -u origin main
sha="$(git -C "$root/clone" rev-parse HEAD)"

source_of() {
  # $1 ref type, $2 ref name, $3 sha, $4 version
  (cd "$root/clone" && GITHUB_REF_TYPE="$1" GITHUB_REF_NAME="$2" GITHUB_SHA="$3" VERSION="$4" \
    bash "$project_dir/scripts/release-source.sh")
}

refuses() {
  local message="$1"; shift
  if source_of "$@" >"$root/out" 2>"$root/err"; then
    echo "release-source unexpectedly accepted: $message" >&2; exit 1
  fi
  grep -F "$message" "$root/err" >/dev/null || { echo "missing refusal: $message" >&2; cat "$root/err" >&2; exit 1; }
}

# A branch dispatch publishes from that branch when nothing has moved.
test "$(source_of branch main "$sha" 0.2.0)" = main
git -C "$root/clone" checkout -q -b topic
git -C "$root/clone" push -q -u origin topic
test "$(source_of branch topic "$sha" 0.2.0)" = topic
git -C "$root/clone" checkout -q main

# A branch dispatch must see origin at the dispatched revision.
git -C "$root/clone" commit -q --allow-empty -m "Moved"
moved="$(git -C "$root/clone" rev-parse HEAD)"
git -C "$root/clone" push -q origin main
refuses "main is not at the run's revision" branch main "$sha" 0.2.0

# A tag push publishes from main when the tag is main's head and names the version.
git -C "$root/clone" tag v0.2.0 "$moved"
git -C "$root/clone" push -q origin refs/tags/v0.2.0
test "$(source_of tag v0.2.0 "$moved" 0.2.0)" = main
refuses "tag v0.2.0 does not name version 0.3.0" tag v0.2.0 "$moved" 0.3.0

# A branch dispatch refuses a version whose tag already exists; Release makes the tag.
refuses "tag v0.2.0 already exists" branch main "$moved" 0.2.0

# A tag that is not main's head cannot be published: the pin would not land.
git -C "$root/clone" commit -q --allow-empty -m "Ahead of the tag"
git -C "$root/clone" push -q origin main
refuses "tag v0.2.0 is not the head of main" tag v0.2.0 "$moved" 0.2.0

# A tag run must be at the tagged commit, whatever the event reported.
refuses "revision is not the commit of tag v0.2.0" tag v0.2.0 "$sha" 0.2.0

refuses "unsupported ref type" other v0.2.0 "$moved" 0.2.0

echo "test_release_source: ok"
