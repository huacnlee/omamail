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

IFS= read -r encoded || fail 'image-fetch.sh: no request on stdin'
[ -n "$encoded" ] || fail 'image-fetch.sh: empty request'
url=$(printf '%s' "$encoded" | base64 -d 2>/dev/null) || fail 'image-fetch.sh: bad base64 field'

# The URL crosses into curl's config format, where escape() below neutralises
# the quote and the backslash but a line break is a field of its own: a CR or
# LF in the value ends the `url = "..."` line and turns whatever follows into
# another curl option. The src of a mail <img> is written by a stranger, and
# `Html.imageSourceKind` classifies it through a normaliser that strips these
# characters — so a URL that reads as a public host to the gate can still carry
# a newline down here. Refuse it, the way calendar-write.sh refuses one, before
# any config is built. (The newline is a literal: command substitution would
# strip a trailing one.)
nl='
'
cr=$(printf '\r')
case $url in
  *"$nl"* | *"$cr"*) fail 'image-fetch.sh: URL may not span lines' ;;
esac

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
answer=$(build_config | curl --config - 2>/dev/null)
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
