#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

mkdir -p "$fixture_dir/bin"

cat >"$fixture_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
set -eu
[ "$1" = "log" ] || exit 2
cat <<'LOG'
Add the first visible change (#11)
Make a release-only improvement (#12)
Merge a change GitHub generated notes missed (#13)
Prepare the version
LOG
EOF

cat >"$fixture_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
[ "$1" != "api" ] || {
  cat <<'NOTES'
## What's Changed
* Generated list that omitted pull request 13

## New Contributors
* @cy made their first contribution in https://example.test/pull/13

**Full Changelog**: generated elsewhere
NOTES
  exit 0
}
[ "$1 $2" = "pr view" ] || exit 2
case "$3" in
  11)
    printf '%s\n' '{"author":{"login":"ada"},"body":"## Summary\nInternal detail.\n\n## Release Notes\n\n- First user-visible result.\n- Second user-visible result.\n\n## Verification\n\nPassed.","number":11,"title":"Add the first visible change","url":"https://example.test/pull/11"}'
    ;;
  12)
    printf '%s\n' '{"author":{"login":"ben"},"body":"No release-notes section here.","number":12,"title":"Make a release-only improvement","url":"https://example.test/pull/12"}'
    ;;
  13)
    printf '%s\n' '{"author":{"login":"cy"},"body":"## Release Notes\n\n- Include the PR that generated notes missed.","number":13,"title":"Merge a change GitHub generated notes missed","url":"https://example.test/pull/13"}'
    ;;
esac
EOF

chmod +x "$fixture_dir/bin/git" "$fixture_dir/bin/gh"

PATH="$fixture_dir/bin:$PATH" \
  "$project_dir/scripts/release-notes.sh" v1.0.0 v1.1.0 >"$fixture_dir/actual"

cat >"$fixture_dir/expected" <<'EOF'
## Release Notes

### Add the first visible change ([#11](https://example.test/pull/11))

- First user-visible result.
- Second user-visible result.

### Merge a change GitHub generated notes missed ([#13](https://example.test/pull/13))

- Include the PR that generated notes missed.

## What's Changed

* Add the first visible change by @ada in https://example.test/pull/11
* Make a release-only improvement by @ben in https://example.test/pull/12
* Merge a change GitHub generated notes missed by @cy in https://example.test/pull/13

## New Contributors

* @cy made their first contribution in https://example.test/pull/13

**Full Changelog**: https://github.com/huacnlee/omamail/compare/v1.0.0...v1.1.0
EOF

diff -u "$fixture_dir/expected" "$fixture_dir/actual"
