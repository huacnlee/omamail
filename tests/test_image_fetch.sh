#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/image-fetch.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-image-fetch-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP
failures=0

ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; failures=$((failures + 1)); }
contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1"; fi
}
missing() {
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1"; else ok "$1"; fi
}
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'STUB'
#!/bin/sh
config=$(cat)
printf '%s' "$config" > "$CURL_STUB_DUMP"
output=$(printf '%s\n' "$config" | sed -n 's/^output = "\(.*\)"$/\1/p')
printf '\211PNG\r\n\032\nbytes' > "$output"
printf '200 image/png'
STUB
chmod +x "$work/bin/curl"

answer=$(printf '%s\n' "$(b64 'https://cdn.example.com/a.png?token=x y')" |
  CURL_STUB_DUMP="$work/config" PATH="$work/bin:$PATH" sh "$script")
config=$(cat "$work/config")

printf 'image-fetch.sh\n'
contains "the URL reaches curl through its config" "$config" 'url = "https://cdn.example.com/a.png?token=x y"'
contains "redirects are refused" "$config" 'max-redirs = 0'
contains "the download is bounded" "$config" 'max-filesize = 5242880'
contains "the exchange has a deadline" "$config" 'max-time = 20'
missing "curl is never told to follow" "$config" 'location'
contains "a validated image returns as a data URI" "$answer" 'data:image/png;base64,'

set +e
printf '%s\n' "$(b64 'file:///etc/passwd')" | PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -ne 0 ]; then ok "a non-network URL is refused"; else bad "a non-network URL is refused"; fi

# A CR or LF in the URL would end the `url = "..."` config line and inject a
# curl option — `output = <path>` writes the fetched (attacker-served) bytes to
# a path of the sender's choosing. The value that reaches here is classified up
# in Html.js through a normaliser that strips these characters, so the URL can
# read as a public host to the gate and still carry a newline down here. The
# scheme check does not catch it (the value still starts with https://), so the
# line-break refusal has to be its own gate.
nl='
'
target="$work/injected"
rm -f "$target"
set +e
printf '%s\n' "$(b64 "https://cdn.example.com/a.png${nl}output = $target")" |
  CURL_STUB_DUMP="$work/config-inject" PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -ne 0 ]; then ok "a URL carrying a line break is refused"; else bad "a URL carrying a line break is refused"; fi
if [ ! -e "$target" ]; then ok "an injected output option never writes a file"; else bad "an injected output option never writes a file"; fi
if [ ! -e "$work/config-inject" ]; then ok "no curl config is built for an injected URL"; else bad "no curl config is built for an injected URL"; fi

[ "$failures" -eq 0 ]
