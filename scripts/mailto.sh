#!/bin/sh
# Hands a mailto: URL to the running Omamail window.
#
# The desktop file's Exec is this script with %u. xdg-open, xdg-email and
# anything else that asks the system to write a message all land here.
# Summon, not toggle: a link while the window is already open must fill a
# draft, not close the mailbox.
set -eu

plugin_id=omamail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [ "$#" -eq 0 ] || [ -z "${1:-}" ]; then
  payload='{}'
else
  command -v python3 >/dev/null 2>&1 || fail 'omamail: python3 is required to open a mailto link'
  payload=$(python3 -c '
import json, sys, urllib.parse
url = sys.argv[1]
payload = {"mailto": url}
query = urllib.parse.urlparse(url).query
files = []
for key, values in urllib.parse.parse_qs(query).items():
    if key.lower() not in ("attach", "attachment"):
        continue
    for raw in values:
        text = raw.strip()
        lower = text.lower()
        if lower.startswith("file://localhost"):
            text = text[16:]
        elif lower.startswith("file://"):
            text = text[7:]
        if text.startswith("/") and "://" not in text:
            files.append(text)
if files:
    payload["attachments"] = files
sys.stdout.write(json.dumps(payload, separators=(",", ":")))
' "$1") || fail 'omamail: could not encode the mailto link'
fi

if [ -n "${OMAMAIL_MAILTO_PRINT:-}" ]; then
  printf '%s\n' "omarchy-shell shell summon $plugin_id $payload"
  exit 0
fi

command -v omarchy-shell >/dev/null 2>&1 || fail 'omamail: omarchy-shell is not on PATH'
exec omarchy-shell shell summon "$plugin_id" "$payload"
