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

json_string() {
  command -v python3 >/dev/null 2>&1 || fail 'omamail: python3 is required to open a mailto link'
  python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
}

if [ "$#" -eq 0 ] || [ -z "${1:-}" ]; then
  payload='{}'
else
  payload="{\"mailto\":$(json_string "$1")}"
fi

if [ -n "${OMAMAIL_MAILTO_PRINT:-}" ]; then
  printf '%s\n' "omarchy-shell shell summon $plugin_id $payload"
  exit 0
fi

command -v omarchy-shell >/dev/null 2>&1 || fail 'omamail: omarchy-shell is not on PATH'
exec omarchy-shell shell summon "$plugin_id" "$payload"
