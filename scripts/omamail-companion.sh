#!/bin/sh
# The MenuBar is deliberately a client of the single-instance host, not a
# second mail process. Keep its vocabulary closed so a QML value can never
# choose a program, option, or host-side command.
set -eu

action=${1:-open}
case "$action" in
  open|refresh)
    [ "$#" -eq 1 ] || exit 64
    ;;
  compose-mailto)
    [ "$#" -eq 2 ] || exit 64
    case "$2" in
      mailto:*) ;;
      *) exit 64 ;;
    esac
    ;;
  *) exit 64 ;;
esac

# There is no host IPC router yet. Starting `omamail --command` now would
# launch a second process and lie about focusing the running one. Keep this as
# a validated future command contract until the host supplies that transport.
exit 69
