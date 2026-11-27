# Omamail on NSH. `nsh` drives the Rust crates and the TSX together; the two
# node scripts check what tsc cannot see (Node 23.6+ runs them as TypeScript).
.PHONY: check build test validate run

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
