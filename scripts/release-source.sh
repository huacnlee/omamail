#!/usr/bin/env bash
# Only an unmoved release/X.Y.Z branch with an unused tag may publish.
set -euo pipefail
fail() { printf 'release-source: %s\n' "$1" >&2; exit 1; }
[ "${GITHUB_REF_TYPE:-}" = branch ] || fail "expected a release branch"
[ "$GITHUB_REF_NAME" = "release/$VERSION" ] || fail "expected release/$VERSION, got $GITHUB_REF_NAME"
git check-ref-format "refs/heads/$GITHUB_REF_NAME"
remote="$(git ls-remote origin "refs/heads/$GITHUB_REF_NAME")"
[ "$remote" = "$(printf '%s\trefs/heads/%s' "$GITHUB_SHA" "$GITHUB_REF_NAME")" ] \
  || fail "$GITHUB_REF_NAME is not at the run's revision"
remote_tag="$(git ls-remote origin "refs/tags/v$VERSION")" || fail "cannot query remote tags"
[ -z "$remote_tag" ] \
  || fail "tag v$VERSION already exists; never overwrite a published version"
printf '%s\n' "$GITHUB_REF_NAME"
