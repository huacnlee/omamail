#!/bin/sh
# The Omarchy plugin's only helper: finds the standalone Omamail app, opens
# it, and hands the plugin's settings over once. Fixed commands only: the
# plugin passes no arguments of its own to anything this runs.
#
#   omamail-app.sh status            prints "installed" or "missing"
#   omamail-app.sh open              starts the app (exit 1 when missing)
#   omamail-app.sh export-settings   reads the plugin's settings (JSON) on
#                                    stdin and keeps them for the app to
#                                    import on its first launch
set -eu

DESKTOP_ID="dev.huacnlee.omamail"
EXPORT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omamail"
EXPORT_FILE="$EXPORT_DIR/plugin-settings.json"

MAX_SETTINGS=65536

# The desktop entry in the user's data directory, then in each directory of
# XDG_DATA_DIRS. The list splits on ':' only, with globbing off, so a path
# holding spaces or '*' is taken as written.
app_exec() {
  set -f
  old_ifs=$IFS
  IFS=:
  for d in "${XDG_DATA_HOME:-$HOME/.local/share}" ${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do
    if [ -n "$d" ] && [ -f "$d/applications/$DESKTOP_ID.desktop" ]; then
      IFS=$old_ifs
      set +f
      printf '%s\n' "$d/applications/$DESKTOP_ID.desktop"
      return 0
    fi
  done
  IFS=$old_ifs
  set +f
  if command -v omamail-app >/dev/null 2>&1; then
    command -v omamail-app
    return 0
  fi
  return 1
}

case "${1:-}" in
  status)
    if app_exec >/dev/null; then echo installed; else echo missing; fi
    ;;
  open)
    found=$(app_exec) || exit 1
    case "$found" in
      *.desktop)
        if command -v gtk-launch >/dev/null 2>&1; then exec gtk-launch "$DESKTOP_ID"; fi
        exec gio launch "$found"
        ;;
      *) exec "$found" ;;
    esac
    ;;
  export-settings)
    # Settings are preferences, never credentials; still private to the owner.
    # The temporary file is made by mktemp inside the target directory (new,
    # exclusive, 0600), then renamed over the export, which replaces a link
    # there rather than following it. More than MAX_SETTINGS bytes is refused
    # whole: a cut-off JSON document is worse than none.
    umask 077
    mkdir -p "$EXPORT_DIR"
    if [ -L "$EXPORT_DIR" ] || [ ! -d "$EXPORT_DIR" ] ||
      [ -z "$(find "$EXPORT_DIR" -prune -user "$(id -u)")" ]; then
      echo "omamail-app.sh: $EXPORT_DIR is not a directory of this user's" >&2
      exit 1
    fi
    tmp=$(mktemp "$EXPORT_DIR/.plugin-settings.json.XXXXXX")
    trap 'rm -f -- "$tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    head -c "$((MAX_SETTINGS + 1))" > "$tmp"
    size=$(wc -c < "$tmp" | tr -d ' ')
    if [ "$size" -gt "$MAX_SETTINGS" ]; then
      echo "omamail-app.sh: settings larger than $MAX_SETTINGS bytes; nothing was written" >&2
      exit 3
    fi
    mv -f -- "$tmp" "$EXPORT_FILE"
    trap - EXIT
    ;;
  *)
    echo "usage: omamail-app.sh status|open|export-settings" >&2
    exit 2
    ;;
esac
