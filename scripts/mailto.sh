#!/bin/sh
# Hands a mailto: URL to the running Omamail window.
#
# The desktop file's Exec is this script with %u. xdg-open, xdg-email and
# anything else that asks the system to write a message all land here.
#
# Two clients, one link, and they are reached differently because they are
# differently shaped. The standalone client is an ordinary process: it takes the
# URL on its own argument vector, and its single-instance router — see
# `src/command_router.rs` — decides whether that opens a window or reaches the
# one that is already up. The shell plugin is not a process this script can talk
# to at all; it lives inside the Omarchy shell, so the link goes through
# `omarchy-shell shell summon`, which delivers the payload to the plugin the
# shell is already hosting.
#
# Summon, not toggle: a link while the window is already open must fill a
# draft, not close the mailbox. The standalone router says the same thing in
# its own vocabulary — `compose-mailto` never closes anything.
#
# The shell plugin is asked first. It is the primary client — the one that is
# native to Omarchy — and merely having built the standalone binary must not
# silently take the machine's mail links away from it. The standalone client
# answers where the shell cannot: on a machine with no Omarchy shell at all
# (macOS, or a plain Linux desktop), or when `OMAMAIL_BIN` names it explicitly.
#
# Resolved at run time rather than written into the desktop file, so neither
# client needs a second install step and nothing has to be undone when one of
# them is removed again.
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

url=${1:-}

standalone=${OMAMAIL_BIN:-}
explicit=$standalone
[ -n "$standalone" ] || standalone=$(command -v omamail 2>/dev/null || true)

# `OMAMAIL_BIN` is a deliberate instruction and outranks the shell; a binary
# merely found on PATH does not.
if [ -z "$explicit" ] && command -v omarchy-shell >/dev/null 2>&1; then
  if [ -z "$url" ]; then
    payload='{}'
  else
    payload="{\"mailto\":$(json_string "$url")}"
  fi
  if [ -n "${OMAMAIL_MAILTO_PRINT:-}" ]; then
    printf '%s\n' "omarchy-shell shell summon $plugin_id $payload"
    exit 0
  fi
  exec omarchy-shell shell summon "$plugin_id" "$payload"
fi

if [ -n "$standalone" ] && [ -x "$standalone" ]; then
  # The scheme is checked here as well as in the router. A desktop handler is
  # reachable by anything on the machine that can call xdg-open, and the vector
  # it builds should not be the first place a non-link is noticed.
  if [ -n "$url" ]; then
    scheme=$(printf '%s' "$url" | cut -c1-7 | tr 'A-Z' 'a-z')
    [ "$scheme" = "mailto:" ] || fail 'omamail: that is not a mailto: link'
    set -- "$standalone" "$url"
  else
    set -- "$standalone"
  fi
  if [ -n "${OMAMAIL_MAILTO_PRINT:-}" ]; then
    printf '%s\n' "$*"
    exit 0
  fi
  exec "$@"
fi

if [ -z "$url" ]; then
  payload='{}'
else
  payload="{\"mailto\":$(json_string "$url")}"
fi

if [ -n "${OMAMAIL_MAILTO_PRINT:-}" ]; then
  printf '%s\n' "omarchy-shell shell summon $plugin_id $payload"
  exit 0
fi

command -v omarchy-shell >/dev/null 2>&1 || fail 'omamail: omarchy-shell is not on PATH'
exec omarchy-shell shell summon "$plugin_id" "$payload"
