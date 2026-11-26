#!/bin/sh
# Emits one line: <verifier>\t<challenge>\t<state>
#
# The verifier never leaves this process except through the plugin's memory:
# it is written to stdout once and the caller drops it as soon as the
# authorization code has been exchanged.
set -eu

umask 077

verifier=$(openssl rand -base64 72 | tr -d '=+/\n' | cut -c1-64)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
state=$(openssl rand -hex 24)

printf '%s\t%s\t%s\n' "$verifier" "$challenge" "$state"
