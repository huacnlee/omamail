# Omamail on NSH. `nsh` drives the Rust crates and the TSX together; the two
# node scripts check what tsc cannot see (Node 23.6+ runs them as TypeScript).
.PHONY: check build test validate run package publish

# Type checks, then the doc and native-module drift checks. The scripts read
# the types `nsh check` generates, so they run after it.
check:
	nsh check
	node scripts/check-keys.ts
	node scripts/check-native-members.ts

build:
	nsh build

test:
	nsh test

# Everything a change must pass before review.
validate: check build test

run:
	nsh run

# This machine's package in .nsh/out (macOS: an ad hoc signed Omamail.app).
package:
	nsh package

# Prepares release/X.Y.Z from a clean main and opens its PR; release.yml
# builds, signs and publishes from that branch. VERSION defaults to the next
# patch. See CONTRIBUTING.md, "Releasing".
publish:
	bash omarchy/scripts/publish.sh $(VERSION)
