#!/usr/bin/env bash
# Publish a backend release from main: bump if asked, commit, tag, push both,
# then follow the Release run the tag push triggers. CI publishes the assets
# and pushes the pin commit back to main; this script never touches
# backend-version and never creates the release itself.
set -euo pipefail

fail() { printf 'publish: %s\n' "$1" >&2; exit 1; }

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
requested="${1-}"
branch="${PUBLISH_BRANCH:-main}"
repository="${GH_REPOSITORY:-huacnlee/omamail}"

gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run: gh auth login"
current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = "$branch" ] || fail "checkout is on $current_branch, not $branch"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
git fetch --quiet origin "$branch"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ] \
  || fail "$branch is not in sync with origin/$branch; pull or push first"

current="$(python3 scripts/package-backend.py check)"
version="${requested:-$current}"
[ -z "$(git ls-remote origin "refs/tags/v$version")" ] \
  || fail "tag v$version already exists on origin; Release creates it itself, so remove it first: git push origin :refs/tags/v$version"
if gh release view "v$version" >/dev/null 2>&1; then
  fail "release v$version already exists"
fi

if [ "$version" != "$current" ]; then
  scripts/bump.sh "$version"
  python3 scripts/package-backend.py check >/dev/null
  git commit --quiet -m "Version $version" -- Cargo.toml Cargo.lock manifest.json
fi
sha="$(git rev-parse HEAD)"
git tag "v$version" "$sha"
# One atomic push: main and the tag land together or not at all, so the tag
# can only ever point at main's head, which is what the pin step requires.
git push --quiet --atomic origin "refs/heads/$branch" "refs/tags/v$version"
echo "Pushed v$version at ${sha:0:12}; waiting for the Release run"

run_id=""
for _ in $(seq 1 30); do
  run_id="$(gh run list --workflow=release.yml --event push --branch "v$version" \
    --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$run_id" ] && [ "$run_id" != null ] && break
  run_id=""
  sleep 5
done
[ -n "$run_id" ] || fail "no Release run appeared for v$version; check https://github.com/$repository/actions"
gh run watch "$run_id" --exit-status
echo "Published https://github.com/$repository/releases/tag/v$version"
echo "CI pushed the pin commit to $branch; fetch it with: git pull"
