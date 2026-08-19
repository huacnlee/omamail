#!/bin/sh
# Stores the Google refresh token in GNOME Keyring, keyed by client id.
# The token arrives on stdin so it never appears in the process table.
set -eu

client_id=${1:-}
if [ -z "$client_id" ]; then
  exit 2
fi

IFS= read -r refresh_token
if [ -z "$refresh_token" ]; then
  exit 3
fi

printf '%s' "$refresh_token" | secret-tool store \
  --label='Omarchy Gmail refresh token' \
  service omarchy-gmail \
  kind refresh-token \
  client-id "$client_id"
