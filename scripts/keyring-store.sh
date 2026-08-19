#!/bin/sh
# Stores a Google refresh token in GNOME Keyring under the attributes given as
# arguments, reading the token from stdin so it never appears in the process
# table.
#
# The attributes come from Credentials.keyringAttributes(), which keys on the
# account as well as the OAuth client: a client belongs to a Cloud project
# rather than to a mailbox, so two accounts sharing one would otherwise
# overwrite each other's token and sign one of them out at random.
set -eu

if [ $# -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; then
  printf '%s\n' 'usage: keyring-store.sh name value [name value ...]' >&2
  exit 2
fi

# An empty attribute value is a wildcard to secret-tool, which would match and
# overwrite the wrong entry.
for value in "$@"; do
  if [ -z "$value" ]; then
    printf '%s\n' 'keyring-store.sh: empty attribute name or value' >&2
    exit 2
  fi
done

IFS= read -r refresh_token
if [ -z "$refresh_token" ]; then
  exit 3
fi

printf '%s' "$refresh_token" | secret-tool store \
  --label='Omamail refresh token' "$@"
