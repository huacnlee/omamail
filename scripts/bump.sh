#!/usr/bin/env bash
# Cut a release: set the manifest version, commit it, tag it, push both.
#
#   scripts/bump.sh 0.2.0
#
# The release workflow refuses a tag that disagrees with the manifest, and by
# then the tag is already pushed and has to be deleted from the remote. Doing
# both from one argument is what makes them agree.
#
# Everything is checked before anything is written, so a refusal leaves the
# working tree exactly as it was.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

fail() { printf 'bump: %s\n' "$1" >&2; exit 1; }

version="${1-}"
[ -n "$version" ] || fail "usage: scripts/bump.sh <version>   (e.g. 0.2.0)"

# The tag is derived from the version rather than taken separately: two
# arguments could disagree, which is the thing this exists to prevent.
case "$version" in
  v*) fail "give the version without the leading v: ${version#v}" ;;
esac
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "version must be MAJOR.MINOR.PATCH, got: $version"
tag="v$version"

current="$(node -p 'require("./manifest.json").version')"
[ "$version" != "$current" ] || fail "the manifest is already $version"

# A release is cut from main. Tagging a branch publishes a version whose
# history is not what anyone will clone.
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "releases are cut from main, not $branch"

# A dirty tree means the tag would describe a commit that does not contain
# what is on disk.
git diff --quiet && git diff --cached --quiet \
  || fail "the working tree has changes; commit or stash them first"

git rev-parse -q --verify "refs/tags/$tag" >/dev/null \
  && fail "$tag already exists locally"
if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
  fail "$tag already exists on the remote"
fi

# Behind the remote means the release would omit commits that are already on
# main, and the push would be rejected afterwards anyway.
git fetch --quiet origin main
[ "$(git rev-list --count HEAD..origin/main)" -eq 0 ] \
  || fail "main is behind origin/main; pull first"

# The suite the release workflow runs, run before the tag rather than after it.
# qmllint is not in it: it needs the Omarchy shell on the import path, so it is
# a local gate rather than part of this.
printf 'bump: %s -> %s\n' "$current" "$version"
make test

# Only the version field, and only in the manifest. Anchored to the key so a
# version string appearing elsewhere in the file is left alone.
node -e '
  var fs = require("fs")
  var file = "manifest.json"
  var raw = fs.readFileSync(file, "utf8")
  var next = process.argv[1]
  var pattern = /("version"\s*:\s*")[^"]+(")/
  if (!pattern.test(raw)) { console.error("no version field in " + file); process.exit(1) }
  fs.writeFileSync(file, raw.replace(pattern, "$1" + next + "$2"))
' "$version"

written="$(node -p 'require("./manifest.json").version')"
[ "$written" = "$version" ] || fail "the manifest still reads $written"

git add manifest.json
git commit -m "chore: $version"
# Annotated, so the tag carries its own date and author rather than inheriting
# the commit's.
git tag -a "$tag" -m "$tag"

git push origin main
git push origin "$tag"

printf 'bump: pushed %s; the release workflow publishes it\n' "$tag"
