#!/usr/bin/env bash
# Resolve the branch a Release run publishes from and pins on, or refuse.
#
# A tag push `vX.Y.Z` publishes from main: the tag must name the Cargo version
# and be main's head, so the pin commit can land on main right behind it. A
# dispatch on a branch publishes from that branch, which must be at the run's
# revision; Release creates the tag itself, so it must not exist yet.
#
# Inputs are the runner's: GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_SHA, and
# VERSION from `package-backend.py check`. Prints the branch name.
set -euo pipefail

fail() { printf 'release-source: %s\n' "$1" >&2; exit 1; }

release_branch="${RELEASE_BRANCH:-main}"
remote_head() { git ls-remote origin "$1" | cut -f1; }

case "$GITHUB_REF_TYPE" in
  tag)
    [ "$GITHUB_REF_NAME" = "v$VERSION" ] \
      || fail "tag $GITHUB_REF_NAME does not name version $VERSION"
    tagged="$(git rev-parse --verify --quiet "refs/tags/$GITHUB_REF_NAME^{commit}" || true)"
    [ "$tagged" = "$GITHUB_SHA" ] \
      || fail "revision is not the commit of tag $GITHUB_REF_NAME"
    [ "$(remote_head "refs/heads/$release_branch")" = "$GITHUB_SHA" ] \
      || fail "tag $GITHUB_REF_NAME is not the head of $release_branch; the pin commit could not land"
    printf '%s\n' "$release_branch"
    ;;
  branch)
    git check-ref-format "refs/heads/$GITHUB_REF_NAME"
    [ "$(remote_head "refs/heads/$GITHUB_REF_NAME")" = "$GITHUB_SHA" ] \
      || fail "$GITHUB_REF_NAME is not at the run's revision"
    [ -z "$(remote_head "refs/tags/v$VERSION")" ] \
      || fail "tag v$VERSION already exists; Release creates the tag itself"
    printf '%s\n' "$GITHUB_REF_NAME"
    ;;
  *)
    fail "unsupported ref type ${GITHUB_REF_TYPE:-<unset>}"
    ;;
esac
