#!/bin/sh
set -eu

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT INT TERM
mkdir -p "$root/bin"
log="$root/cargo.log"
cat > "$root/bin/cargo" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$DEV_TEST_LOG"
EOF
chmod +x "$root/bin/cargo"

dev="$PWD/dev"
output=$(cd "$root" && PATH="$root/bin:$PATH" DEV_TEST_LOG="$log" "$dev" backend)
test "$(cat "$log")" = "build --locked --manifest-path $PWD/Cargo.toml --target-dir $PWD/target --bin omamail"
test "$output" = "Built $PWD/target/debug/omamail"

output=$(cd "$root" && PATH="$root/bin:$PATH" DEV_TEST_LOG="$log" "$dev" run)
test "$(cat "$log")" = "build --locked --manifest-path $PWD/Cargo.toml --target-dir $PWD/target --bin omamail"
printf '%s\n' "$output" | grep -F "OMAMAIL_BIN=$PWD/target/debug/omamail"
printf '%s\n' "$output" | grep -F "restart the existing Omarchy shell"
printf '%s\n' "$output" | grep -F "omarchy shell shell toggle omamail '{}'"

if PATH="$root/bin:$PATH" DEV_TEST_LOG="$log" ./dev unknown >"$root/out" 2>"$root/err"; then
  echo "unknown command unexpectedly succeeded" >&2
  exit 1
fi
grep -F "Usage: ./dev backend | run" "$root/err"
