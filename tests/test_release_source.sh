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

# Only the exact versioned release branch can publish; main, topics and tags cannot.
refuses "expected release/0.2.0" branch main "$sha" 0.2.0
refuses "expected release/0.2.0" branch topic "$sha" 0.2.0
refuses "expected a release branch" tag v0.2.0 "$sha" 0.2.0
git -C "$root/clone" checkout -q -b release/0.2.0
git -C "$root/clone" push -q -u origin release/0.2.0
test "$(source_of branch release/0.2.0 "$sha" 0.2.0)" = release/0.2.0
refuses "expected release/0.3.0" branch release/0.2.0 "$sha" 0.3.0

# Moving a source or reusing a tag fails before publication.
git -C "$root/clone" commit -q --allow-empty -m Moved
moved="$(git -C "$root/clone" rev-parse HEAD)"
git -C "$root/clone" push -q origin release/0.2.0
refuses "not at the run's revision" branch release/0.2.0 "$sha" 0.2.0
git -C "$root/clone" push -q origin HEAD:refs/tags/v0.2.0
refuses "tag v0.2.0 already exists" branch release/0.2.0 "$moved" 0.2.0
refuses "expected a release branch" other release/0.2.0 "$moved" 0.2.0

# A remote lookup failure is not evidence of an unused tag.
mkdir "$root/bin"
export RELEASE_TEST_REAL_GIT="$(command -v git)"
cat >"$root/bin/git" <<'GIT'
#!/usr/bin/env bash
if [ "$1" = ls-remote ] && [[ "$3" == refs/tags/* ]]; then exit 1; fi
exec "$RELEASE_TEST_REAL_GIT" "$@"
GIT
chmod +x "$root/bin/git"
PATH="$root/bin:$PATH" refuses "cannot query remote tags" branch release/0.2.0 "$moved" 0.2.0

echo "test_release_source: ok"
