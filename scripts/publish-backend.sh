#!/usr/bin/env bash
# Run after both native builds; only verified public assets may advance the pin.
set -euo pipefail
python3 scripts/package-backend.py check --tag "v$VERSION"
# Refuse a moved source branch or any pre-existing tag.
test "$(bash scripts/release-source.sh)" = "$BRANCH"
gh api --paginate "repos/$GITHUB_REPOSITORY/releases" --jq '.[].tag_name' > releases.txt
if grep -Fx "v$VERSION" releases.txt; then echo 'Release version already exists' >&2; exit 1; else test "$?" -eq 1; fi
mkdir release-assets
cp artifacts/backend-x86_64/omamail-linux-x86_64.tar.gz release-assets/
cp artifacts/backend-aarch64/omamail-linux-aarch64.tar.gz release-assets/
cat artifacts/backend-x86_64/SHA256SUMS artifacts/backend-aarch64/SHA256SUMS > release-assets/SHA256SUMS
cmp artifacts/backend-x86_64/backend-api.json artifacts/backend-aarch64/backend-api.json
cp artifacts/backend-x86_64/backend-api.json release-assets/
# The asset is this revision's own contract, byte for byte; the pin
# step below is what turns its unreleased step into the released API.
cmp backend-api.json release-assets/backend-api.json
cmp artifacts/backend-x86_64/backend-build.json artifacts/backend-aarch64/backend-build.json
cp artifacts/backend-x86_64/backend-build.json release-assets/
python3 scripts/package-backend.py check-provenance release-assets/backend-build.json
python3 scripts/package-backend.py verify release-assets
# Derive notes from merged PR descriptions, using the previous pin.
previous="$(python3 scripts/package-backend.py pin-version)"
git tag "v$VERSION" "$GITHUB_SHA"
bash scripts/release-notes.sh "v$previous" "v$VERSION" > release-notes.md
# An explicit non-force tag push refuses a racing publisher. Tags do
# not trigger this workflow; the pin commit is excluded by paths above.
git push origin "refs/tags/v$VERSION"
gh release create "v$VERSION" release-assets/* --verify-tag --draft --title "v$VERSION" --notes-file release-notes.md
gh release edit "v$VERSION" --draft=false
mkdir published
gh release download "v$VERSION" --dir published --pattern 'omamail-linux-*.tar.gz' --pattern SHA256SUMS --pattern backend-build.json --pattern backend-api.json
python3 scripts/package-backend.py verify published
python3 scripts/package-backend.py check-provenance published/backend-build.json
cmp release-assets/backend-api.json published/backend-api.json
cmp release-assets/backend-build.json published/backend-build.json
cmp release-assets/SHA256SUMS published/SHA256SUMS
# Refuse moved refs and push only a pin commit, without force. The
# commit advances backend-version and folds the contract's unreleased
# step into its released API, which the published binary now speaks.
python3 scripts/package-backend.py pin --branch "$BRANCH" --expected "$GITHUB_SHA"
