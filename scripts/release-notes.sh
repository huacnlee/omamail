#!/usr/bin/env bash
# Build a release body from the pull requests merged between two tags.
set -euo pipefail

fail() { printf 'release-notes: %s\n' "$1" >&2; exit 1; }

previous_tag="${1-}"
current_tag="${2-}"
[ -n "$previous_tag" ] && [ -n "$current_tag" ] \
  || fail "usage: scripts/release-notes.sh <previous-tag> <current-tag>"

repository="${GH_REPOSITORY:-huacnlee/omamail}"
notes_dir="$(mktemp -d)"
trap 'rm -rf "$notes_dir"' EXIT

mapfile -t pull_requests < <(
  git log --reverse --format=%s "$previous_tag..$current_tag" \
    | sed -nE 's/.*\(#([0-9]+)\)$/\1/p' \
    | awk '!seen[$0]++'
)

for pull_request in "${pull_requests[@]}"; do
  gh pr view "$pull_request" --repo "$repository" \
    --json author,body,number,title,url >"$notes_dir/$pull_request.json"
done

generated_notes="$(
  gh api --method POST "repos/$repository/releases/generate-notes" \
    -f tag_name="$current_tag" \
    -f previous_tag_name="$previous_tag" \
    --jq '.body'
)"

has_release_notes=false
for pull_request in "${pull_requests[@]}"; do
  body="$(jq -r '.body // ""' "$notes_dir/$pull_request.json")"
  section="$(
    printf '%s\n' "$body" | awk '
      $0 == "## Release Notes" { reading = 1; next }
      reading && /^##[[:space:]]/ { exit }
      reading && !started && $0 == "" { next }
      reading { started = 1; print }
    '
  )"
  [ -n "$section" ] || continue

  if [ "$has_release_notes" = false ]; then
    printf '## Release Notes\n\n'
    has_release_notes=true
  fi

  title="$(jq -r '.title' "$notes_dir/$pull_request.json")"
  url="$(jq -r '.url' "$notes_dir/$pull_request.json")"
  number="$(jq -r '.number' "$notes_dir/$pull_request.json")"
  printf '### %s ([#%s](%s))\n\n%s\n\n' "$title" "$number" "$url" "$section"
done

printf "## What's Changed\n\n"
for pull_request in "${pull_requests[@]}"; do
  title="$(jq -r '.title' "$notes_dir/$pull_request.json")"
  author="$(jq -r '.author.login' "$notes_dir/$pull_request.json")"
  url="$(jq -r '.url' "$notes_dir/$pull_request.json")"
  printf '* %s by @%s in %s\n' "$title" "$author" "$url"
done


new_contributors="$(
  printf '%s\n' "$generated_notes" | awk '
    $0 == "## New Contributors" { reading = 1; next }
    reading && /^\*\*Full Changelog\*\*/ { exit }
    reading && $0 != "" { print }
  '
)"
[ -z "$new_contributors" ] \
  || printf '\n## New Contributors\n\n%s\n' "$new_contributors"

printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n' \
  "$repository" "$previous_tag" "$current_tag"
