#!/usr/bin/env bash
# Prepare one release PR. CI publishes the backend before updating its pin.
set -euo pipefail
fail() { printf 'publish: %s\n' "$1" >&2; exit 1; }
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
export GH_REPO="${GH_REPOSITORY:-huacnlee/omamail}"
repository="$GH_REPO"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run: gh auth login"
current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = main ] || fail "checkout is on $current_branch, not main"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || fail "main is not in sync with origin/main; fetch and reconcile it first"
current="$(python3 scripts/package-backend.py check)"
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
bash scripts/bump.sh "$version"
python3 scripts/package-backend.py check >/dev/null
git commit --quiet -m "Version $version" -- Cargo.toml Cargo.lock manifest.json app/CMakeLists.txt
sha="$(git rev-parse HEAD)"
git push --quiet -u origin "HEAD:refs/heads/$branch"
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
cat >"$body_file" <<EOF
Publish Omamail v$version from this branch. Release CI builds and verifies the plugin backends and all three standalone desktop packages, creates the tag and one release, then updates backend-version and the released API contract in this PR after verifying every public download.

Merge this PR once the pin commit and required checks pass. Main receives the version and runtime pin together in one merge.

## Release Notes

- Update the Omarchy backend and standalone desktop applications to v$version.
EOF
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
echo "Review the pin commit and required checks, then merge $pr_url"
