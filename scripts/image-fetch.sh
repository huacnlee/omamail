#!/bin/sh
# Fetches one already-approved remote mail image without following redirects.
# The URL crosses on stdin as base64 and successful bytes return as a data URI,
# so QTextDocument never receives a remote src while it is still loading.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

command -v curl >/dev/null 2>&1 || fail 'image-fetch.sh: curl is not installed'

decode() {
  printf '%s' "$1" | base64 -d 2>/dev/null || fail 'image-fetch.sh: bad base64 field'
}

IFS= read -r line || fail 'image-fetch.sh: no request on stdin'
[ -n "$line" ] || fail 'image-fetch.sh: empty request'
# The URL and every host-resolver pin are base64 fields. Pins come from the
# host's checked DNS answer and bind curl to those exact addresses, so a second
# lookup cannot redirect the request into the local network.
# shellcheck disable=SC2086
set -- $line
[ $# -ge 1 ] || fail 'image-fetch.sh: usage: <b64 url> [<b64 resolve> ...]'
url=$(decode "$1")
shift

case "$url" in
  http://*|https://*) ;;
  *) fail 'image-fetch.sh: refusing a URL that is not HTTP(S)' ;;
esac

escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-image.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP
body="$work/body"
escaped_url=$(escape "$url")
escaped_body=$(escape "$body")

build_config() {
  printf 'url = "%s"\n' "$escaped_url"
  # A proxy would resolve the hostname itself and bypass the host-provided
  # address pins, so this request must connect directly.
  printf 'noproxy = "*"\n'
  for encoded_pin in "$@"; do
    pin=$(decode "$encoded_pin")
    printf 'resolve = "%s"\n' "$(escape "$pin")"
  done
  printf 'output = "%s"\n' "$escaped_body"
  printf 'max-redirs = 0\n'
  printf 'proto = "=http,https"\n'
  printf 'proto-redir = "=http,https"\n'
  printf 'max-time = 20\n'
  printf 'connect-timeout = 10\n'
  printf 'max-filesize = 5242880\n'
  printf 'silent\n'
  printf 'show-error\n'
  printf 'write-out = "%%{http_code} %%{content_type}"\n'
}

set +e
answer=$(build_config "$@" | curl --config - 2>/dev/null)
code=$?
set -e
[ "$code" -eq 0 ] || fail 'image-fetch.sh: download failed'

status=${answer%% *}
mime=${answer#* }
case "$status" in
  2??) ;;
  *) fail 'image-fetch.sh: server refused the image' ;;
esac
mime=${mime%%;*}
case "$mime" in
  image/png|image/jpeg|image/jpg|image/gif|image/webp|image/bmp) ;;
  *) fail 'image-fetch.sh: response is not a supported image' ;;
esac
[ -s "$body" ] || fail 'image-fetch.sh: image is empty'

printf 'data:%s;base64,' "$mime"
base64 < "$body" | tr -d '\n'
printf '\n'
