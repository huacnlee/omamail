#!/usr/bin/env bash
# Prepare one release PR: a release/X.Y.Z branch with the new version, whose
# push runs release.yml. CI packages macOS, Linux and Windows, signs the update
# manifest, tags and publishes the release, then verifies the public
# downloads. Main stays PR-only: merge the release PR after it has published.
set -euo pipefail
fail() { printf 'publish: %s\n' "$1" >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
export GH_REPO="${GH_REPOSITORY:-huacnlee/omamail}"
repository="$GH_REPO"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run: gh auth login"
current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = main ] || fail "checkout is on $current_branch, not main"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || fail "main is not in sync with origin/main; fetch and reconcile it first"
current="$(python3 omarchy/scripts/release.py version)" || fail "the versioned files disagree"
version="${1:-$(python3 -c 'import sys; a,b,c = map(int, sys.argv[1].split(".")); print(f"{a}.{b}.{c+1}")' "$current")}"
# Validate before constructing refs, querying GitHub, or editing the checkout.
python3 - "$current" "$version" <<'PY'
import re, sys
current, version = sys.argv[1:]
if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
    raise SystemExit('publish: expected canonical MAJOR.MINOR.PATCH')
if tuple(map(int, version.split('.'))) <= tuple(map(int, current.split('.'))):
    raise SystemExit('publish: version must be newer than ' + current)
PY
branch="release/$version"
remote_tag="$(git ls-remote origin "refs/tags/v$version")" || fail "cannot query remote tags"
[ -z "$remote_tag" ] || fail "tag v$version already exists on origin; choose a new version"
remote_branch="$(git ls-remote origin "refs/heads/$branch")" || fail "cannot query remote branches"
[ -z "$remote_branch" ] || fail "$branch already exists on origin; inspect its PR and Release run"
if git show-ref --verify --quiet "refs/heads/$branch"; then fail "$branch already exists locally"; fi
releases="$(gh api --paginate "repos/$repository/releases" --jq '.[].tag_name')" || fail "cannot list releases"
if grep -Fxq "v$version" <<<"$releases"; then fail "release v$version already exists; choose a new version"; fi

git switch --quiet -c "$branch"
files="$(bash omarchy/scripts/bump.sh "$version")"
# shellcheck disable=SC2086 # one path per line, none with spaces
git commit --quiet -m "Version $version" -- $files
sha="$(git rev-parse HEAD)"
git push --quiet -u origin "HEAD:refs/heads/$branch"
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
cat >"$body_file" <<BODY
Publish Omamail v$version from this branch. Release CI packages the app for macOS (Apple silicon), Linux (x86_64) and Windows (x86_64), signs the update manifest that installed apps check, creates the tag and the release, and verifies every public download.

Merge this PR once the release is published and the required checks pass.

## Release Notes

- Omamail v$version for macOS, Linux and Windows.
BODY
pr_url="$(gh pr create --base main --head "$branch" --title "Release v$version" --body-file "$body_file")"
echo "$pr_url"
echo "Pushed $branch at ${sha:0:12}; waiting for Release"
run_id=""
for _ in $(seq 1 30); do
  run_id="$(gh run list --workflow release.yml --event push --branch "$branch" --commit "$sha" \
    --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$run_id" ] && [ "$run_id" != null ] && break
  run_id=""
  sleep 5
done
[ -n "$run_id" ] || fail "no Release run appeared; inspect $pr_url and https://github.com/$repository/actions"
gh run watch "$run_id" --exit-status
echo "Published https://github.com/$repository/releases/tag/v$version"
echo "Merge $pr_url once its checks pass"
