#!/usr/bin/env bash
# Run after every native build; only one complete, verified release may advance the pin.
set -euo pipefail
python3 scripts/package-backend.py check --tag "v$VERSION"
# Refuse a moved source branch or any pre-existing tag.
test "$(bash scripts/release-source.sh)" = "$BRANCH"
gh api --paginate "repos/$GITHUB_REPOSITORY/releases" --jq '.[].tag_name' > releases.txt
if grep -Fx "v$VERSION" releases.txt; then echo 'Release version already exists' >&2; exit 1; else test "$?" -eq 1; fi
mkdir release-assets
cp artifacts/backend-x86_64/omamail-linux-x86_64.tar.gz release-assets/
cp artifacts/backend-aarch64/omamail-linux-aarch64.tar.gz release-assets/
cp artifacts/app-macos-aarch64/omamail-app-macos-aarch64.tar.gz release-assets/
cp artifacts/app-linux-x86_64/omamail-app-linux-x86_64.tar.gz release-assets/
# Windows is temporarily not released:
# cp artifacts/app-windows-x86_64/omamail-app-windows-x86_64.zip release-assets/
cp install.sh install.ps1 release-assets/
cmp artifacts/backend-x86_64/backend-api.json artifacts/backend-aarch64/backend-api.json
cp artifacts/backend-x86_64/backend-api.json release-assets/
# The asset is this revision's own contract, byte for byte; the pin
# step below is what turns its unreleased step into the released API.
cmp backend-api.json release-assets/backend-api.json
cmp artifacts/backend-x86_64/backend-build.json artifacts/backend-aarch64/backend-build.json
cp artifacts/backend-x86_64/backend-build.json release-assets/
python3 scripts/package-backend.py check-provenance release-assets/backend-build.json
python3 scripts/package-backend.py release-checksums release-assets
python3 scripts/package-backend.py verify release-assets
python3 scripts/package-backend.py verify-release release-assets
# Derive notes from merged PR descriptions, using the previous pin.
previous="$(python3 scripts/package-backend.py pin-version)"
git tag "v$VERSION" "$GITHUB_SHA"
bash scripts/release-notes.sh "v$previous" "v$VERSION" > release-notes.md
# An explicit non-force tag push refuses a racing publisher. Tags do
# not trigger this workflow; the pin commit is excluded by paths above.
git push origin "refs/tags/v$VERSION"
gh release create "v$VERSION" release-assets/* --verify-tag --draft --title "v$VERSION" --notes-file release-notes.md
mkdir draft-download
gh release download "v$VERSION" --dir draft-download
python3 scripts/package-backend.py verify draft-download
python3 scripts/package-backend.py verify-release draft-download
python3 scripts/package-backend.py check-provenance draft-download/backend-build.json
for asset in \
  omamail-linux-x86_64.tar.gz omamail-linux-aarch64.tar.gz \
  omamail-app-macos-aarch64.tar.gz omamail-app-linux-x86_64.tar.gz \
  install.sh install.ps1 SHA256SUMS \
  backend-api.json backend-build.json; do
  cmp "release-assets/$asset" "draft-download/$asset"
done
# Public visibility comes only after GitHub has returned every draft asset byte
# and those bytes have passed the same release contract as the local aggregate.
gh release edit "v$VERSION" --draft=false
# Pinning waits for a fresh public download as well. The public CDN/API path is
# a separate delivery boundary from the draft upload and must return the exact
# bytes that were approved above.
mkdir public-download
gh release download "v$VERSION" --dir public-download
python3 scripts/package-backend.py verify public-download
python3 scripts/package-backend.py verify-release public-download
python3 scripts/package-backend.py check-provenance public-download/backend-build.json
for asset in \
  omamail-linux-x86_64.tar.gz omamail-linux-aarch64.tar.gz \
  omamail-app-macos-aarch64.tar.gz omamail-app-linux-x86_64.tar.gz \
  install.sh install.ps1 SHA256SUMS \
  backend-api.json backend-build.json; do
  cmp "release-assets/$asset" "public-download/$asset"
done
# Refuse moved refs and push only a pin commit, without force. The
# commit advances backend-version and folds the contract's unreleased
# step into its released API, which the published binary now speaks.
python3 scripts/package-backend.py pin --branch "$BRANCH" --expected "$GITHUB_SHA"
